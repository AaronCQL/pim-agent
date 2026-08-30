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

type DuckDuckGoFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
) => ReturnType<typeof fetch>;

export type DuckDuckGoProviderOptions = {
  readonly readerEndpoint?: string;
  readonly searchEndpoint?: string;
  readonly apiKey?: string;
  readonly fetch?: DuckDuckGoFetch;
  readonly timeoutMs?: number;
};

const RESULT_LINE = /^\s*\d+\.\[(.*?)\]\((\S+?)\)\s*$/u;
const BARE_DOMAIN_LINE = /^[\w-]+(\.[\w-]+)+(\/\S*)?$/u;

/**
 * DuckDuckGo blocks direct API access with a 202 anti-bot challenge, so this
 * reads the Lite SERP through Jina's keyless reader instead. Last-resort tier:
 * no credentials anywhere in the path, but also no stability guarantee.
 */
export class DuckDuckGoProvider implements SearchProvider {
  public static readonly defaultReaderEndpoint = "https://r.jina.ai";
  public static readonly defaultSearchEndpoint =
    "https://lite.duckduckgo.com/lite/";
  private static readonly defaultTimeoutMs = 30_000;

  public readonly name = "duckduckgo";

  private readonly readerEndpoint: string;
  private readonly searchEndpoint: string;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly timeoutMs: number;
  private readonly ky: KyInstance;

  public constructor(options: DuckDuckGoProviderOptions = {}) {
    this.readerEndpoint = (
      options.readerEndpoint ?? DuckDuckGoProvider.defaultReaderEndpoint
    ).replace(/\/+$/u, "");
    this.searchEndpoint =
      options.searchEndpoint ?? DuckDuckGoProvider.defaultSearchEndpoint;
    this.timeoutMs = options.timeoutMs ?? DuckDuckGoProvider.defaultTimeoutMs;
    this.headers = {
      Accept: "application/json",
      // Reader caches aggressively; a stale SERP snapshot is worse than a slow
      // one for a search tool.
      "x-no-cache": "true",
      ...(options.apiKey === undefined || options.apiKey.length === 0
        ? {}
        : { Authorization: `Bearer ${options.apiKey}` }),
    };
    this.ky = ky.create(
      options.fetch === undefined
        ? {}
        : { fetch: options.fetch as typeof fetch }
    );
  }

  public async search(
    input: ProviderSearchInput
  ): Promise<readonly SearchResult[]> {
    const target = `${this.searchEndpoint}?q=${encodeURIComponent(input.query)}`;
    const url = `${this.readerEndpoint}/${encodeURIComponent(target)}`;
    let response: Response;

    try {
      response = await this.ky(url, {
        headers: this.headers,
        timeout: this.timeoutMs,
        retry: 0,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      throw this.toProviderError(error, input.signal);
    }

    const content = this.readContent(await response.text());

    return this.parse(content).slice(0, input.numResults);
  }

  private toProviderError(error: unknown, signal?: AbortSignal): unknown {
    if (signal?.aborted || isAbortError(error)) {
      return error;
    }

    if (error instanceof HTTPError) {
      const { status, headers } = error.response;

      if (status === 429 || status === 402) {
        return new ProviderQuotaError(
          this.name,
          "Jina reader rejected the request: free tier limit reached.",
          parseRetryAfterMs(headers.get("retry-after"))
        );
      }

      return new ProviderSearchError(
        this.name,
        `DuckDuckGo lookup failed with HTTP ${status}.`
      );
    }

    if (error instanceof TimeoutError) {
      return new ProviderSearchError(
        this.name,
        `DuckDuckGo lookup timed out after ${this.timeoutMs}ms.`
      );
    }

    return new ProviderSearchError(
      this.name,
      `DuckDuckGo lookup failed: ${describeError(error)}`
    );
  }

  private readContent(body: string): string {
    const parsed = tryParseJson(body);

    if (parsed === undefined) {
      return body;
    }

    const record = asRecord(parsed);
    const data = asRecord(record?.["data"]) ?? record;
    const content = data?.["content"];

    if (typeof content !== "string") {
      throw new ProviderSearchError(
        this.name,
        "Jina reader returned an unexpected payload."
      );
    }

    return content;
  }

  private parse(content: string): readonly SearchResult[] {
    const lines = content.split(/\r?\n/u);
    const results: SearchResult[] = [];
    let current: { title: string; url: string; snippet: string[] } | undefined;

    const flush = (): void => {
      if (current === undefined) {
        return;
      }

      results.push({
        title: stripEmphasis(current.title),
        url: current.url,
        snippet: normalizeSnippet(stripEmphasis(joinSnippet(current.snippet))),
      });
      current = undefined;
    };

    for (const line of lines) {
      const match = RESULT_LINE.exec(line);

      if (match) {
        flush();
        const url = resolveRedirect(match[2]!);

        if (url !== undefined) {
          current = { title: match[1] ?? "", url, snippet: [] };
        }

        continue;
      }

      const trimmed = line.trim();

      if (current !== undefined && trimmed.length > 0) {
        current.snippet.push(trimmed);
      }
    }

    flush();

    if (results.length === 0 && !/no\s+results/iu.test(content)) {
      throw new ProviderSearchError(
        this.name,
        "DuckDuckGo returned no parseable results (likely bot-blocked)."
      );
    }

    return results;
  }
}

/**
 * Lite SERP links are wrapped as `duckduckgo.com/l/?uddg=<encoded target>`.
 */
function resolveRedirect(href: string): string | undefined {
  let parsed: URL;

  try {
    parsed = new URL(href);
  } catch {
    return undefined;
  }

  const target = parsed.searchParams.get("uddg");

  if (target !== null && target.length > 0) {
    return target;
  }

  return parsed.hostname.endsWith("duckduckgo.com") ? undefined : href;
}

/**
 * The last snippet line of a Lite result is the display URL, not prose.
 */
function joinSnippet(lines: readonly string[]): string {
  const last = lines.at(-1);
  const body =
    last !== undefined && BARE_DOMAIN_LINE.test(last)
      ? lines.slice(0, -1)
      : lines;

  return body.join(" ");
}

function stripEmphasis(value: string): string {
  return value.replaceAll("**", "");
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
