import { Json } from "../../shared/Json";
import { McpClient, type McpFetch } from "../../shared/McpClient";
import { RateLimiter } from "../../shared/RateLimiter";
import {
  normalizeSnippet,
  type SearchResult,
} from "./providers/SearchProvider";

type ExaMcpClientOptions = {
  readonly endpoint?: string;
  readonly apiKey?: string;
  readonly fetch?: McpFetch;
  readonly rateLimiter?: RateLimiter;
};

type ExaSearchInput = {
  readonly query: string;
  readonly numResults: number;
  readonly signal?: AbortSignal;
};

type ResultObject = Readonly<Record<string, unknown>>;

class ExaSearchError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ExaSearchError";
  }
}

const defaultEndpoint = "https://mcp.exa.ai/mcp";
const toolName = "web_search_exa";
// Stay under the keyless 2 req/s limit so a 429 means the daily cap.
const maxRequestsPerWindow = 2;
const windowMs = 1100;

export class ExaMcpClient {
  private readonly client: McpClient;

  public constructor(options: ExaMcpClientOptions = {}) {
    const apiKey =
      options.apiKey === undefined || options.apiKey.length === 0
        ? undefined
        : options.apiKey;
    // An API key lifts the rate limit.
    const rateLimiter =
      apiKey !== undefined
        ? undefined
        : (options.rateLimiter ??
          new RateLimiter({
            maxRequests: maxRequestsPerWindow,
            windowMs: windowMs,
          }));

    this.client = new McpClient({
      endpoint: options.endpoint ?? defaultEndpoint,
      ...(apiKey === undefined ? {} : { headers: { "x-api-key": apiKey } }),
      ...(rateLimiter === undefined ? {} : { rateLimiter }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  public async search(input: ExaSearchInput): Promise<readonly SearchResult[]> {
    const result = await this.client.callTool({
      name: toolName,
      arguments: {
        query: input.query,
        numResults: input.numResults,
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });

    return extractResults(result);
  }
}

function extractResults(result: unknown): readonly SearchResult[] {
  const record = Json.asRecord(result);
  const content = record?.["content"];

  if (!Array.isArray(content) || content.length === 0) {
    throw new ExaSearchError("Exa returned malformed tool content.");
  }

  const textBlocks = content.map(readTextBlock);
  const plainTextResults = extractPlainTextResults(textBlocks);

  if (plainTextResults !== undefined) {
    return plainTextResults;
  }

  const resultObjects = findFirstObjectArray(
    textBlocks
      .map((block) => Json.tryParseJson(block))
      .filter((value) => value !== undefined)
  );

  if (resultObjects === undefined) {
    throw new ExaSearchError("Exa returned malformed search results.");
  }

  return resultObjects.map(projectResult);
}

function readTextBlock(block: unknown): string {
  const record = Json.asRecord(block);

  if (record?.["type"] !== "text" || typeof record["text"] !== "string") {
    throw new ExaSearchError("Exa returned malformed tool content.");
  }

  return record["text"];
}

function extractPlainTextResults(
  textBlocks: readonly string[]
): readonly SearchResult[] | undefined {
  for (const textBlock of textBlocks) {
    const blocks = textBlock
      .split(/\n---\n/u)
      .map((block) => block.trim())
      .filter((block) => block.length > 0);
    const results = blocks
      .map((block) => parsePlainTextResult(block))
      .filter((result) => result !== undefined);

    if (results.length > 0) {
      return results;
    }
  }

  return undefined;
}

function parsePlainTextResult(block: string): SearchResult | undefined {
  const lines = block
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const title = readLabeledLine(lines, "Title");
  const url = readLabeledLine(lines, "URL");

  if (title === undefined || url === undefined) {
    return undefined;
  }

  return {
    title,
    url,
    snippet: normalizeSnippet(readPlainTextSnippet(lines)),
  };
}

function readLabeledLine(
  lines: readonly string[],
  label: string
): string | undefined {
  const prefix = `${label}:`;
  const line = lines.find((candidate) =>
    candidate.toLowerCase().startsWith(prefix.toLowerCase())
  );

  return line?.slice(prefix.length).trim();
}

function readPlainTextSnippet(lines: readonly string[]): string {
  const highlightsIndex = lines.findIndex((line) =>
    line.toLowerCase().startsWith("highlights:")
  );
  const snippetLines =
    highlightsIndex === -1 ? lines : lines.slice(highlightsIndex + 1);
  const skipPrefixes = ["title:", "url:", "published:", "author:"];
  return snippetLines
    .filter((line) => {
      if (line.startsWith("[...]")) {
        return false;
      }
      const lower = line.toLowerCase();
      return !skipPrefixes.some((prefix) => lower.startsWith(prefix));
    })
    .join(" ");
}

function findFirstObjectArray(
  values: readonly unknown[]
): readonly ResultObject[] | undefined {
  for (const value of values) {
    if (isObjectArray(value)) {
      return value;
    }
    const nested = Object.values(Json.asRecord(value) ?? {}).find(
      isObjectArray
    );
    if (nested !== undefined) {
      return nested;
    }
  }

  return undefined;
}

function isObjectArray(value: unknown): value is readonly ResultObject[] {
  return (
    Array.isArray(value) &&
    value.every((item) => Json.asRecord(item) !== undefined)
  );
}

function projectResult(result: ResultObject): SearchResult {
  return {
    title: readResultString(result, "title"),
    url: readResultString(result, "url"),
    snippet: normalizeSnippet(readSnippet(result)),
  };
}

function readSnippet(result: ResultObject): string {
  return (
    readOptionalResultString(result, "snippet") ??
    readOptionalResultString(result, "text") ??
    readOptionalResultString(result, "summary") ??
    ""
  );
}

function readResultString(result: ResultObject, name: string): string {
  const value = readOptionalResultString(result, name);

  if (value === undefined) {
    throw new ExaSearchError(`Exa returned a result without ${name}.`);
  }

  return value;
}

function readOptionalResultString(
  result: ResultObject,
  name: string
): string | undefined {
  const value = result[name];

  return typeof value === "string" ? value : undefined;
}
