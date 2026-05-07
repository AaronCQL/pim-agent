import ky, { HTTPError, type KyInstance } from "ky";

export type McpFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
) => ReturnType<typeof fetch>;

export type McpClientOptions = {
  readonly endpoint: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: McpFetch;
  readonly clientName?: string;
  readonly clientVersion?: string;
};

export type CallToolInput = {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
};

type JsonRpcResponse = {
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
};

export class McpClientError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "McpClientError";
  }
}

export class McpClient {
  private static readonly protocolVersion = "2025-06-18";

  private readonly endpoint: string;
  private readonly extraHeaders: Readonly<Record<string, string>>;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly ky: KyInstance;
  private nextRequestId = 1;

  public constructor(options: McpClientOptions) {
    this.endpoint = options.endpoint;
    this.extraHeaders = options.headers ?? {};
    this.clientName = options.clientName ?? "pim-agent";
    this.clientVersion = options.clientVersion ?? "0.0.0";
    this.ky = ky.create(
      options.fetch === undefined
        ? {}
        : { fetch: options.fetch as typeof fetch }
    );
  }

  public async callTool(input: CallToolInput): Promise<unknown> {
    let sessionId: string | undefined;
    let activeRequestId: number | undefined;

    try {
      activeRequestId = this.nextRequestId++;
      const initialize = await this.sendRpcRequest({
        id: activeRequestId,
        method: "initialize",
        params: {
          protocolVersion: McpClient.protocolVersion,
          clientInfo: {
            name: this.clientName,
            version: this.clientVersion,
          },
          capabilities: {},
        },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      sessionId = initialize.sessionId;

      await this.sendNotification({
        sessionId,
        method: "notifications/initialized",
        params: {},
      });

      activeRequestId = this.nextRequestId++;
      const toolCall = await this.sendRpcRequest({
        id: activeRequestId,
        ...(sessionId === undefined ? {} : { sessionId }),
        method: "tools/call",
        params: {
          name: input.name,
          arguments: input.arguments,
        },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });

      return toolCall.envelope.result;
    } catch (error) {
      if (input.signal?.aborted) {
        await this.sendCancellation(sessionId, activeRequestId);
        throw new McpClientError("MCP request aborted.");
      }

      throw error;
    }
  }

  private async sendRpcRequest(input: {
    readonly id: number;
    readonly sessionId?: string;
    readonly method: string;
    readonly params: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly envelope: JsonRpcResponse;
    readonly sessionId: string | undefined;
  }> {
    const response = await this.postJson(
      {
        jsonrpc: "2.0",
        id: input.id,
        method: input.method,
        params: input.params,
      },
      input.sessionId,
      input.signal
    );
    const envelope = await this.readRpcResponse(response, input.id);
    const sessionId =
      input.sessionId ?? response.headers.get("mcp-session-id") ?? undefined;

    if (asRecord(envelope.error) !== undefined) {
      throw new McpClientError(
        `MCP JSON-RPC error: ${describeRpcError(envelope.error)}`
      );
    }

    return { envelope, sessionId };
  }

  private async sendNotification(input: {
    readonly sessionId: string | undefined;
    readonly method: string;
    readonly params: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    await this.postJson(
      {
        jsonrpc: "2.0",
        method: input.method,
        params: input.params,
      },
      input.sessionId
    );
  }

  private async sendCancellation(
    sessionId: string | undefined,
    requestId: number | undefined
  ): Promise<void> {
    if (sessionId === undefined || requestId === undefined) {
      return;
    }

    try {
      await this.sendNotification({
        sessionId,
        method: "notifications/cancelled",
        params: {
          requestId,
          reason: "Tool call aborted.",
        },
      });
    } catch {
      // abort already surfaces; cancel is best-effort
    }
  }

  private async postJson(
    body: Readonly<Record<string, unknown>>,
    sessionId?: string,
    signal?: AbortSignal
  ): Promise<Response> {
    try {
      return await this.ky(this.endpoint, {
        method: "POST",
        headers: this.createHeaders(sessionId),
        json: body,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }

      if (error instanceof HTTPError) {
        throw new McpClientError(
          `MCP request failed with HTTP ${error.response.status}: ${excerpt(stringifyErrorData(error.data))}`
        );
      }

      throw new McpClientError(`MCP request failed: ${describeThrown(error)}`);
    }
  }

  private createHeaders(sessionId: string | undefined): Headers {
    const headers = new Headers({
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": McpClient.protocolVersion,
    });

    if (sessionId !== undefined) {
      headers.set("mcp-session-id", sessionId);
    }

    for (const [name, value] of Object.entries(this.extraHeaders)) {
      headers.set(name, value);
    }

    return headers;
  }

  private async readRpcResponse(
    response: Response,
    id: number
  ): Promise<JsonRpcResponse> {
    const contentType = response.headers.get("content-type") ?? "";

    if (contentType.includes("text/event-stream")) {
      return this.readSseRpcResponse(response, id);
    }

    const parsed = parseJson(await response.text());
    const envelope = asRpcResponse(parsed);

    if (envelope === undefined || envelope.id !== id) {
      throw new McpClientError("MCP returned a malformed JSON-RPC envelope.");
    }

    return envelope;
  }

  private async readSseRpcResponse(
    response: Response,
    id: number
  ): Promise<JsonRpcResponse> {
    if (response.body === null) {
      throw new McpClientError("MCP returned an empty SSE response.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventName = "message";
    const dataLines: string[] = [];

    const dispatch = (): JsonRpcResponse | undefined => {
      const data = dataLines.join("\n");
      const currentEventName = eventName;

      dataLines.length = 0;
      eventName = "message";

      if (data.length === 0 || currentEventName !== "message") {
        return undefined;
      }

      const envelope = asRpcResponse(parseJson(data));

      if (envelope === undefined) {
        throw new McpClientError("MCP returned a malformed JSON-RPC envelope.");
      }

      return envelope.id === id ? envelope : undefined;
    };

    try {
      while (true) {
        const read = await reader.read();

        buffer += decoder.decode(read.value, { stream: !read.done });

        while (true) {
          const newlineIndex = buffer.indexOf("\n");

          if (newlineIndex === -1) {
            break;
          }

          const rawLine = buffer.slice(0, newlineIndex);
          const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

          buffer = buffer.slice(newlineIndex + 1);

          if (line.length === 0) {
            const envelope = dispatch();

            if (envelope !== undefined) {
              return envelope;
            }

            continue;
          }

          if (line.startsWith("event:")) {
            eventName = line.slice("event:".length).trim();
            continue;
          }

          if (line.startsWith("data:")) {
            dataLines.push(line.slice("data:".length).trimStart());
          }
        }

        if (read.done) {
          const envelope = dispatch();

          if (envelope !== undefined) {
            return envelope;
          }

          break;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }

    throw new McpClientError(
      "MCP SSE response did not include the expected message."
    );
  }
}

function asRecord(
  value: unknown
): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Readonly<Record<string, unknown>>;
}

function asRpcResponse(value: unknown): JsonRpcResponse | undefined {
  const record = asRecord(value);

  if (record === undefined) {
    return undefined;
  }

  return {
    ...(record["id"] === undefined ? {} : { id: record["id"] }),
    ...(record["result"] === undefined ? {} : { result: record["result"] }),
    ...(record["error"] === undefined ? {} : { error: record["error"] }),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new McpClientError("MCP returned invalid JSON.");
  }
}

function describeRpcError(error: unknown): string {
  const record = asRecord(error);
  const message = record?.["message"];

  if (typeof message === "string" && message.length > 0) {
    return message;
  }

  return JSON.stringify(error);
}

function describeThrown(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function stringifyErrorData(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }

  if (data === undefined) {
    return "";
  }

  return JSON.stringify(data);
}

function excerpt(text: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();

  if (normalized.length === 0) {
    return "<empty>";
  }

  return normalized.length > 200
    ? `${normalized.slice(0, 200)}...`
    : normalized;
}
