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

export type DuckDuckGoProviderOptions = {
  readonly readerEndpoint?: string;
  readonly searchEndpoint?: string;
  readonly apiKey?: string;
  readonly fetch?: HttpFetch;
  readonly timeoutMs?: number;
};

const RESULT_LINE = /^\s*\d+\.\[(.*?)\]\((\S+?)\)\s*$/u;
const BARE_DOMAIN_LINE = /^[\w-]+(\.[\w-]+)+(\/\S*)?$/u;

const defaultReaderEndpoint = "https://r.jina.ai";
const defaultSearchEndpoint = "https://lite.duckduckgo.com/lite/";
const defaultTimeoutMs = 30_000;

/** Reads the Lite SERP through Jina: DuckDuckGo answers direct API calls with a 202 anti-bot challenge. */
export class DuckDuckGoProvider implements SearchProvider {
  public readonly name = "duckduckgo";

  private readonly readerEndpoint: string;
  private readonly searchEndpoint: string;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly timeoutMs: number;
  private readonly ky: KyInstance;

  public constructor(options: DuckDuckGoProviderOptions = {}) {
    this.readerEndpoint = (
      options.readerEndpoint ?? defaultReaderEndpoint
    ).replace(/\/+$/u, "");
    this.searchEndpoint = options.searchEndpoint ?? defaultSearchEndpoint;
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.headers = {
      Accept: "application/json",
      // The reader caches aggressively and would serve a stale SERP.
      "x-no-cache": "true",
      ...(options.apiKey === undefined || options.apiKey.length === 0
        ? {}
        : { Authorization: `Bearer ${options.apiKey}` }),
    };
    this.ky = createKy(options.fetch);
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
    return mapProviderError({
      provider: this.name,
      subject: "DuckDuckGo lookup",
      error,
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: this.timeoutMs,
      quotaStatuses: [429, 402],
      quotaMessage:
        "Jina reader rejected the request: free tier limit reached.",
    });
  }

  private readContent(body: string): string {
    const parsed = Json.tryParseJson(body);

    if (parsed === undefined) {
      return body;
    }

    const record = Json.asRecord(parsed);
    const data = Json.asRecord(record?.["data"]) ?? record;
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

// Lite SERP links are wrapped as `duckduckgo.com/l/?uddg=<encoded target>`.
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

// The last snippet line of a Lite result is the display URL, not prose.
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
