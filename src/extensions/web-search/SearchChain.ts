import type { SearchBreaker } from "./SearchBreaker";
import {
  isAbortError,
  ProviderQuotaError,
  type ProviderSearchInput,
  type SearchProvider,
  type SearchResult,
} from "./providers/SearchProvider";

export type ChainSearchOutcome = {
  readonly provider: string;
  readonly results: readonly SearchResult[];
  readonly fellBack: boolean;
};

export type SearchChainOptions = {
  readonly providers: readonly SearchProvider[];
  readonly breaker: SearchBreaker;
};

/**
 * Tries providers in order until one answers.
 *
 * Two rules make this safe to run against metered free tiers:
 * an empty result set is a legitimate answer and terminates the chain (a query
 * with genuinely no hits must not burn every provider's quota), and a quota
 * rejection additionally sidelines the provider via the breaker so later
 * searches skip it outright.
 */
export class SearchChain {
  private readonly providers: readonly SearchProvider[];
  private readonly breaker: SearchBreaker;

  public constructor(options: SearchChainOptions) {
    this.providers = options.providers;
    this.breaker = options.breaker;
  }

  public async search(input: ProviderSearchInput): Promise<ChainSearchOutcome> {
    const failures: string[] = [];
    let attempted = false;

    for (const provider of this.providers) {
      if (await this.breaker.isOpen(provider.name)) {
        failures.push(`${provider.name}: skipped (quota exhausted)`);
        continue;
      }

      if (input.signal?.aborted) {
        throw new Error("Web search aborted before execution.");
      }

      try {
        const results = await provider.search(input);
        await this.breaker.reset(provider.name);

        return { provider: provider.name, results, fellBack: attempted };
      } catch (error) {
        if (input.signal?.aborted || isAbortError(error)) {
          throw error;
        }

        attempted = true;

        if (error instanceof ProviderQuotaError) {
          await this.breaker.trip({
            provider: provider.name,
            reason: error.message,
            ...(error.retryAfterMs === undefined
              ? {}
              : { retryAfterMs: error.retryAfterMs }),
          });
        }

        failures.push(`${provider.name}: ${describeError(error)}`);
      }
    }

    throw new Error(
      `All web search providers failed:\n${failures
        .map((failure) => `  - ${failure}`)
        .join("\n")}`
    );
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
