import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SearchBreaker } from "./SearchBreaker";
import { SearchChain } from "./SearchChain";
import {
  ProviderQuotaError,
  ProviderSearchError,
  type ProviderSearchInput,
  type SearchProvider,
  type SearchResult,
} from "./providers/SearchProvider";

const paths: string[] = [];

function breakerPath(): string {
  const path = join(tmpdir(), `pim-breaker-${Bun.randomUUIDv7()}.json`);
  paths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { force: true })));
});

function stubProvider(
  name: string,
  handler: (input: ProviderSearchInput) => Promise<readonly SearchResult[]>
): SearchProvider & { calls: number } {
  const provider = {
    name,
    calls: 0,
    async search(input: ProviderSearchInput) {
      provider.calls += 1;
      return handler(input);
    },
  };
  return provider;
}

function result(url: string): SearchResult {
  return { title: url, url, snippet: "" };
}

const input: ProviderSearchInput = { query: "pim agent", numResults: 5 };

describe("SearchChain", () => {
  test("uses the first provider and reports no fallback", async () => {
    const first = stubProvider("exa", async () => [result("https://a.test")]);
    const second = stubProvider("firecrawl", async () => [
      result("https://b.test"),
    ]);
    const chain = new SearchChain({
      providers: [first, second],
      breaker: new SearchBreaker({ path: breakerPath() }),
    });

    const outcome = await chain.search(input);

    expect(outcome.provider).toBe("exa");
    expect(outcome.fellBack).toBe(false);
    expect(second.calls).toBe(0);
  });

  test("treats an empty result set as a terminal answer", async () => {
    const first = stubProvider("exa", async () => []);
    const second = stubProvider("firecrawl", async () => [
      result("https://b.test"),
    ]);
    const chain = new SearchChain({
      providers: [first, second],
      breaker: new SearchBreaker({ path: breakerPath() }),
    });

    const outcome = await chain.search(input);

    expect(outcome.provider).toBe("exa");
    expect(outcome.results).toEqual([]);
    expect(second.calls).toBe(0);
  });

  test("falls back to the next provider on a generic failure", async () => {
    const first = stubProvider("exa", async () => {
      throw new ProviderSearchError("exa", "malformed payload");
    });
    const second = stubProvider("firecrawl", async () => [
      result("https://b.test"),
    ]);
    const chain = new SearchChain({
      providers: [first, second],
      breaker: new SearchBreaker({ path: breakerPath() }),
    });

    const outcome = await chain.search(input);

    expect(outcome.provider).toBe("firecrawl");
    expect(outcome.fellBack).toBe(true);
  });

  test("skips a quota-exhausted provider on the next search", async () => {
    const path = breakerPath();
    const first = stubProvider("exa", async () => {
      throw new ProviderQuotaError("exa", "daily limit reached");
    });
    const second = stubProvider("firecrawl", async () => [
      result("https://b.test"),
    ]);
    const chain = new SearchChain({
      providers: [first, second],
      breaker: new SearchBreaker({ path }),
    });

    await chain.search(input);
    await chain.search(input);

    expect(first.calls).toBe(1);
    expect(second.calls).toBe(2);
  });

  test("does not sideline a provider that merely errored", async () => {
    const path = breakerPath();
    const first = stubProvider("exa", async () => {
      throw new ProviderSearchError("exa", "transient blip");
    });
    const second = stubProvider("firecrawl", async () => [
      result("https://b.test"),
    ]);
    const chain = new SearchChain({
      providers: [first, second],
      breaker: new SearchBreaker({ path }),
    });

    await chain.search(input);
    await chain.search(input);

    expect(first.calls).toBe(2);
  });

  test("rethrows aborts instead of burning the next provider", async () => {
    const controller = new AbortController();
    const first = stubProvider("exa", async () => {
      controller.abort();
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });
    const second = stubProvider("firecrawl", async () => [
      result("https://b.test"),
    ]);
    const chain = new SearchChain({
      providers: [first, second],
      breaker: new SearchBreaker({ path: breakerPath() }),
    });

    await expect(
      chain.search({ ...input, signal: controller.signal })
    ).rejects.toThrow("aborted");
    expect(second.calls).toBe(0);
  });

  test("reports every provider failure when the chain is exhausted", async () => {
    const chain = new SearchChain({
      providers: [
        stubProvider("exa", async () => {
          throw new ProviderQuotaError("exa", "daily limit reached");
        }),
        stubProvider("firecrawl", async () => {
          throw new ProviderSearchError("firecrawl", "HTTP 500");
        }),
      ],
      breaker: new SearchBreaker({ path: breakerPath() }),
    });

    await expect(chain.search(input)).rejects.toThrow(
      /exa: daily limit reached[\s\S]*firecrawl: HTTP 500/u
    );
  });

  test("recovers a sidelined provider once it answers again", async () => {
    const path = breakerPath();
    let failing = true;
    const first = stubProvider("exa", async () => {
      if (failing) {
        throw new ProviderQuotaError("exa", "daily limit reached");
      }
      return [result("https://a.test")];
    });
    const second = stubProvider("firecrawl", async () => [
      result("https://b.test"),
    ]);
    const build = (now: () => number) =>
      new SearchChain({
        providers: [first, second],
        breaker: new SearchBreaker({ path, now, probeIntervalMs: 1000 }),
      });

    await build(() => 0).search(input);
    failing = false;

    const outcome = await build(() => 2000).search(input);

    expect(outcome.provider).toBe("exa");
    expect(await new SearchBreaker({ path }).isOpen("exa")).toBe(false);
  });
});
