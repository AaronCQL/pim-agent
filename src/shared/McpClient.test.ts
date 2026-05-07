import { expect, test } from "bun:test";
import { McpClient } from "./McpClient";

type MockFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
) => ReturnType<typeof fetch>;

type CapturedRequest = {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Readonly<Record<string, unknown>>;
};

const captureRequest = async (
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1] | undefined
): Promise<CapturedRequest> => {
  if (input instanceof Request) {
    const text = await input.clone().text();

    return {
      url: input.url,
      headers: input.headers,
      body: JSON.parse(text) as Readonly<Record<string, unknown>>,
    };
  }

  return {
    url: String(input),
    headers: new Headers(init?.headers),
    body: JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>,
  };
};

const okToolCallResponse = (result: unknown): Response =>
  Response.json({ jsonrpc: "2.0", id: 2, result });

test("performs the initialize → initialized → tools/call round trip", async () => {
  const requests: CapturedRequest[] = [];
  const fetcher: MockFetch = async (input, init) => {
    const request = await captureRequest(input, init);
    requests.push(request);

    if (request.body["method"] === "initialize") {
      return Response.json(
        { jsonrpc: "2.0", id: 1, result: {} },
        { headers: { "mcp-session-id": "session-json" } }
      );
    }

    if (request.body["method"] === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }

    return okToolCallResponse({ ok: true });
  };
  const client = new McpClient({
    endpoint: "https://mcp.test/mcp",
    headers: { "x-api-key": "test-key" },
    fetch: fetcher,
  });

  await expect(
    client.callTool({ name: "demo_tool", arguments: { x: 1 } })
  ).resolves.toEqual({ ok: true });

  expect(requests.map((request) => request.url)).toEqual([
    "https://mcp.test/mcp",
    "https://mcp.test/mcp",
    "https://mcp.test/mcp",
  ]);
  expect(requests[1]?.headers.get("mcp-session-id")).toBe("session-json");
  expect(requests[2]?.headers.get("mcp-session-id")).toBe("session-json");
  expect(requests[0]?.headers.get("x-api-key")).toBe("test-key");
  for (const request of requests) {
    expect(request.headers.get("mcp-protocol-version")).toBe("2025-06-18");
  }
  expect(requests[0]?.body).toEqual({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      clientInfo: {
        name: "pim-agent",
        version: "0.0.0",
      },
      capabilities: {},
    },
  });
  expect(requests[2]?.body).toEqual({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "demo_tool",
      arguments: { x: 1 },
    },
  });
});

test("parses SSE responses", async () => {
  const ssePayload = [
    "event: message",
    `data: ${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { ok: true },
    })}`,
    "",
    "",
  ].join("\n");
  const fetcher: MockFetch = async (input, init) => {
    const request = await captureRequest(input, init);

    if (request.body["method"] === "initialize") {
      return Response.json(
        { jsonrpc: "2.0", id: 1, result: {} },
        { headers: { "mcp-session-id": "session-sse" } }
      );
    }

    if (request.body["method"] === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }

    return new Response(ssePayload, {
      headers: { "content-type": "text/event-stream" },
    });
  };
  const client = new McpClient({
    endpoint: "https://mcp.test/mcp",
    fetch: fetcher,
  });

  await expect(
    client.callTool({ name: "demo_tool", arguments: {} })
  ).resolves.toEqual({ ok: true });
});

test("throws clean errors for HTTP failures", async () => {
  const fetcher: MockFetch = async () =>
    new Response("upstream unavailable and not useful beyond this excerpt", {
      status: 503,
    });
  const client = new McpClient({
    endpoint: "https://mcp.test/mcp",
    fetch: fetcher,
  });

  await expect(
    client.callTool({ name: "demo_tool", arguments: {} })
  ).rejects.toThrow("MCP request failed with HTTP 503: upstream unavailable");
});

test("throws clean errors for JSON-RPC failures", async () => {
  const fetcher: MockFetch = async (input, init) => {
    const request = await captureRequest(input, init);

    if (request.body["method"] === "initialize") {
      return Response.json(
        { jsonrpc: "2.0", id: 1, result: {} },
        { headers: { "mcp-session-id": "session-error" } }
      );
    }

    if (request.body["method"] === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }

    return Response.json({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32602, message: "Invalid input." },
    });
  };
  const client = new McpClient({
    endpoint: "https://mcp.test/mcp",
    fetch: fetcher,
  });

  await expect(
    client.callTool({ name: "demo_tool", arguments: {} })
  ).rejects.toThrow("MCP JSON-RPC error: Invalid input.");
});

test("sends cancellation notification on aborted calls", async () => {
  const abortController = new AbortController();
  const requests: CapturedRequest[] = [];
  const fetcher: MockFetch = async (input, init) => {
    const request = await captureRequest(input, init);
    requests.push(request);

    if (request.body["method"] === "initialize") {
      return Response.json(
        { jsonrpc: "2.0", id: 1, result: {} },
        { headers: { "mcp-session-id": "session-abort" } }
      );
    }

    if (request.body["method"] === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }

    if (request.body["method"] === "tools/call") {
      abortController.abort();
      throw new DOMException("Aborted", "AbortError");
    }

    return new Response(null, { status: 202 });
  };
  const client = new McpClient({
    endpoint: "https://mcp.test/mcp",
    fetch: fetcher,
  });

  await expect(
    client.callTool({
      name: "demo_tool",
      arguments: {},
      signal: abortController.signal,
    })
  ).rejects.toThrow("MCP request aborted.");

  expect(requests.at(-1)?.body).toEqual({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: {
      requestId: 2,
      reason: "Tool call aborted.",
    },
  });
  expect(requests.at(-1)?.headers.get("mcp-session-id")).toBe("session-abort");
});
