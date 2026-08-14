import ky, { HTTPError, TimeoutError, type KyInstance } from "ky";
import {
  isAbortError,
  normalizeSnippet,
  parseRetryAfterMs,
  ProviderQuotaError,
  ProviderSearchError,
  type ProviderSearchInput,
  type SearchProvider,
  type SearchResult,
} from "./SearchProvider";

type FirecrawlFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
) => ReturnType<typeof fetch>;

export type FirecrawlProviderOptions = {
  readonly endpoint?: string;
  readonly apiKey?: string;
  readonly fetch?: FirecrawlFetch;
  readonly timeoutMs?: number;
};

/**
 * Firecrawl's search endpoint works with no credentials at all: the keyless
 * tier is the same URL with the `Authorization` header omitted, metered per IP
 * per day. It sends no rate-limit headers, so exhaustion is only observable as
 * a 429 on the call that trips it.
 */
export class FirecrawlProvider implements SearchProvider {
  public static readonly defaultEndpoint =
    "https://api.firecrawl.dev/v2/search";
  private static readonly defaultTimeoutMs = 20_000;

  public readonly name = "firecrawl";

  private readonly endpoint: string;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly timeoutMs: number;
  private readonly ky: KyInstance;

  public constructor(options: FirecrawlProviderOptions = {}) {
    this.endpoint = options.endpoint ?? FirecrawlProvider.defaultEndpoint;
    this.timeoutMs = options.timeoutMs ?? FirecrawlProvider.defaultTimeoutMs;
    this.headers =
      options.apiKey === undefined || options.apiKey.length === 0
        ? {}
        : { Authorization: `Bearer ${options.apiKey}` };
    this.ky = ky.create(
      options.fetch === undefined
        ? {}
        : { fetch: options.fetch as typeof fetch }
    );
  }

  public async search(
    input: ProviderSearchInput
  ): Promise<readonly SearchResult[]> {
    let response: Response;

    try {
      response = await this.ky(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.headers },
        json: {
          query: input.query,
          limit: input.numResults,
          sources: ["web"],
        },
        timeout: this.timeoutMs,
        retry: 0,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      throw await this.toProviderError(error, input.signal);
    }

    return this.parse(await response.text());
  }

  private async toProviderError(
    error: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (signal?.aborted || isAbortError(error)) {
      return error;
    }

    if (error instanceof HTTPError) {
      const { status, headers } = error.response;

      if (status === 429) {
        // Firecrawl meters a rolling 24h window, not a calendar day, and
        // reports the remainder in the body rather than a Retry-After header.
        const retryAfterMs =
          readRetryAfterMs(error.data) ??
          parseRetryAfterMs(headers.get("retry-after"));

        return new ProviderQuotaError(
          this.name,
          "Firecrawl rejected the request: keyless daily limit reached.",
          retryAfterMs
        );
      }

      return new ProviderSearchError(
        this.name,
        `Firecrawl request failed with HTTP ${status}.`
      );
    }

    if (error instanceof TimeoutError) {
      return new ProviderSearchError(
        this.name,
        `Firecrawl request timed out after ${this.timeoutMs}ms.`
      );
    }

    return new ProviderSearchError(
      this.name,
      `Firecrawl request failed: ${describeError(error)}`
    );
  }

  private parse(body: string): readonly SearchResult[] {
    let payload: unknown;

    try {
      payload = JSON.parse(body);
    } catch {
      throw new ProviderSearchError(
        this.name,
        "Firecrawl returned malformed JSON."
      );
    }

    const record = asRecord(payload);

    if (record?.["success"] === false) {
      throw new ProviderSearchError(
        this.name,
        `Firecrawl reported a failure: ${readString(record["error"]) ?? "unknown error"}`
      );
    }

    const data = asRecord(record?.["data"]);
    const web = data?.["web"];

    if (!Array.isArray(web)) {
      throw new ProviderSearchError(
        this.name,
        "Firecrawl returned malformed search results."
      );
    }

    return web
      .map((entry) => this.project(entry))
      .filter((entry): entry is SearchResult => entry !== undefined);
  }

  private project(entry: unknown): SearchResult | undefined {
    const record = asRecord(entry);
    const url = readString(record?.["url"]);

    if (record === undefined || url === undefined) {
      return undefined;
    }

    return {
      title: readString(record["title"]) ?? url,
      url,
      snippet: normalizeSnippet(readString(record["description"])),
    };
  }
}

function readRetryAfterMs(data: unknown): number | undefined {
  const payload = typeof data === "string" ? tryParseJson(data) : data;
  const seconds = asRecord(payload)?.["retry_after_seconds"];

  return typeof seconds === "number" && Number.isFinite(seconds)
    ? Math.max(0, seconds) * 1000
    : undefined;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(
  value: unknown
): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Readonly<Record<string, unknown>>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
