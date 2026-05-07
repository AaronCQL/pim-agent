import { expect, test } from "bun:test";
import { ExaMcpClient } from "./ExaMcpClient";

type MockFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
) => ReturnType<typeof fetch>;

const captureMethod = async (
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1] | undefined
): Promise<string> => {
  if (input instanceof Request) {
    const body = (await input.clone().json()) as { method?: string };
    return body.method ?? "";
  }
  const body = JSON.parse(String(init?.body)) as { method?: string };
  return body.method ?? "";
};

const handshakeOr = (toolCallResponse: () => Response): MockFetch => {
  return async (input, init) => {
    const method = await captureMethod(input, init);

    if (method === "initialize") {
      return Response.json(
        { jsonrpc: "2.0", id: 1, result: {} },
        { headers: { "mcp-session-id": "session" } }
      );
    }

    if (method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }

    return toolCallResponse();
  };
};

test("parses Exa JSON results", async () => {
  const client = new ExaMcpClient({
    fetch: handshakeOr(() =>
      Response.json({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                results: [
                  {
                    title: "Pim docs",
                    url: "https://example.test/pim",
                    snippet: "A concise result.",
                  },
                ],
              }),
            },
          ],
        },
      })
    ),
  });

  await expect(
    client.search({ query: "pim agent", numResults: 3 })
  ).resolves.toEqual([
    {
      title: "Pim docs",
      url: "https://example.test/pim",
      snippet: "A concise result.",
    },
  ]);
});

test("parses Exa plain-text result blocks", async () => {
  const client = new ExaMcpClient({
    fetch: handshakeOr(() =>
      Response.json({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [
            {
              type: "text",
              text: [
                "Title: First text result",
                "URL: https://example.test/first",
                "Published: N/A",
                "Author: N/A",
                "Highlights:",
                "First highlighted sentence.",
                "[...]",
                "Second highlighted sentence.",
                "",
                "---",
                "",
                "Title: Second text result",
                "URL: https://example.test/second",
                "Highlights:",
                "Another result.",
              ].join("\n"),
            },
          ],
        },
      })
    ),
  });

  await expect(
    client.search({ query: "text result", numResults: 2 })
  ).resolves.toEqual([
    {
      title: "First text result",
      url: "https://example.test/first",
      snippet: "First highlighted sentence. Second highlighted sentence.",
    },
    {
      title: "Second text result",
      url: "https://example.test/second",
      snippet: "Another result.",
    },
  ]);
});

test("throws clean errors for malformed tool envelopes", async () => {
  const client = new ExaMcpClient({
    fetch: handshakeOr(() =>
      Response.json({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [{ type: "image", url: "https://example.test/image.png" }],
        },
      })
    ),
  });

  await expect(client.search({ query: "pim", numResults: 1 })).rejects.toThrow(
    "Exa returned malformed tool content."
  );
});
