import { Json } from "../../../shared/Json";
import { createKy, type HttpFetch } from "../../../shared/Http";
import type { KyInstance } from "ky";
import {
  mapProviderError,
  normalizeSnippet,
  ProviderSearchError,
  type ProviderSearchInput,
  type SearchProvider,
  type SearchResult,
} from "./SearchProvider";

export type FirecrawlProviderOptions = {
  readonly endpoint?: string;
  readonly apiKey?: string;
  readonly fetch?: HttpFetch;
  readonly timeoutMs?: number;
};

const defaultEndpoint = "https://api.firecrawl.dev/v2/search";
const defaultTimeoutMs = 20_000;

/**
 * Firecrawl's search endpoint works with no credentials at all: the keyless
 * tier is the same URL with the `Authorization` header omitted, metered per IP
 * per day. It sends no rate-limit headers, so exhaustion is only observable as
 * a 429 on the call that trips it.
 */
export class FirecrawlProvider implements SearchProvider {
  public readonly name = "firecrawl";

  private readonly endpoint: string;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly timeoutMs: number;
  private readonly ky: KyInstance;

  public constructor(options: FirecrawlProviderOptions = {}) {
    this.endpoint = options.endpoint ?? defaultEndpoint;
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.headers =
      options.apiKey === undefined || options.apiKey.length === 0
        ? {}
        : { Authorization: `Bearer ${options.apiKey}` };
    this.ky = createKy(options.fetch);
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
      throw this.toProviderError(error, input.signal);
    }

    return this.parse(await response.text());
  }

  private toProviderError(error: unknown, signal?: AbortSignal): unknown {
    return mapProviderError({
      provider: this.name,
      subject: "Firecrawl request",
      error,
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: this.timeoutMs,
      quotaStatuses: [429],
      quotaMessage:
        "Firecrawl rejected the request: keyless daily limit reached.",
      // Firecrawl meters a rolling 24h window, not a calendar day, and
      // reports the remainder in the body rather than a Retry-After header.
      readRetryAfterMs,
    });
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

    const record = Json.asRecord(payload);

    if (record?.["success"] === false) {
      throw new ProviderSearchError(
        this.name,
        `Firecrawl reported a failure: ${readString(record["error"]) ?? "unknown error"}`
      );
    }

    const data = Json.asRecord(record?.["data"]);
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
    const record = Json.asRecord(entry);
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
  const payload = typeof data === "string" ? Json.tryParseJson(data) : data;
  const seconds = Json.asRecord(payload)?.["retry_after_seconds"];

  return typeof seconds === "number" && Number.isFinite(seconds)
    ? Math.max(0, seconds) * 1000
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
