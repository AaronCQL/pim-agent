import { HTTPError, TimeoutError } from "ky";
import { Errors } from "../../../shared/Errors";

export type SearchResult = {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
};

export type ProviderSearchInput = {
  readonly query: string;
  readonly numResults: number;
  readonly signal?: AbortSignal;
};

export type SearchProvider = {
  readonly name: string;
  search(input: ProviderSearchInput): Promise<readonly SearchResult[]>;
};

/** Quota or rate limit exhausted; only this error opens the breaker and sidelines a provider. */
export class ProviderQuotaError extends Error {
  public readonly provider: string;
  public readonly retryAfterMs: number | undefined;

  public constructor(provider: string, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "ProviderQuotaError";
    this.provider = provider;
    this.retryAfterMs = retryAfterMs;
  }
}

export class ProviderSearchError extends Error {
  public readonly provider: string;

  public constructor(provider: string, message: string) {
    super(message);
    this.name = "ProviderSearchError";
    this.provider = provider;
  }
}

const MAX_SNIPPET_LENGTH = 500;

/** Caps a provider snippet; Firecrawl returns whole scraped pages where others return two lines. */
export function normalizeSnippet(value: string | undefined): string {
  const collapsed = (value ?? "").replaceAll(/\s+/gu, " ").trim();

  return collapsed.length > MAX_SNIPPET_LENGTH
    ? `${collapsed.slice(0, MAX_SNIPPET_LENGTH)}...`
    : collapsed;
}

export function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  const seconds = Number(value.trim());

  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const date = Date.parse(value);

  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export type ProviderErrorInput = {
  readonly provider: string;
  readonly subject: string;
  readonly error: unknown;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly quotaStatuses: readonly number[];
  readonly quotaMessage: string;
  readonly readRetryAfterMs?: (data: unknown) => number | undefined;
};

export function mapProviderError(input: ProviderErrorInput): unknown {
  const { provider, subject, error } = input;

  if (input.signal?.aborted || Errors.isAbort(error)) {
    return error;
  }

  if (error instanceof HTTPError) {
    const { status, headers } = error.response;

    if (input.quotaStatuses.includes(status)) {
      return new ProviderQuotaError(
        provider,
        input.quotaMessage,
        input.readRetryAfterMs?.(error.data) ??
          parseRetryAfterMs(headers.get("retry-after"))
      );
    }

    return new ProviderSearchError(
      provider,
      `${subject} failed with HTTP ${status}.`
    );
  }

  if (error instanceof TimeoutError) {
    return new ProviderSearchError(
      provider,
      `${subject} timed out after ${input.timeoutMs}ms.`
    );
  }

  return new ProviderSearchError(
    provider,
    `${subject} failed: ${Errors.describe(error)}`
  );
}
