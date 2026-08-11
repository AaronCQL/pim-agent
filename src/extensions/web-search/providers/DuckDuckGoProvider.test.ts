import { describe, expect, test } from "bun:test";

import { DuckDuckGoProvider } from "./DuckDuckGoProvider";
import { ProviderQuotaError } from "./SearchProvider";

function redirect(target: string): string {
  return `https://duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&rut=abc`;
}

const SERP = [
  `1.[Test runner - Bun](${redirect("https://bun.com/docs/test")})`,
  "**Bun's** fast, built-in, Jest-compatible **test****runner**",
  "bun.com/docs/test",
  "",
  `2.[Welcome to Bun](${redirect("https://bun.com/docs")})`,
  "**Bun** ships as a single, dependency-free binary.",
  "bun.com/docs",
].join("\n");

function providerWith(
  status: number,
  body: string,
  headers: Record<string, string> = {}
): { provider: DuckDuckGoProvider; requested: string[] } {
  const requested: string[] = [];
  const provider = new DuckDuckGoProvider({
    fetch: async (url, init) => {
      requested.push(new Request(url as never, init as never).url);
      return new Response(body, {
        status,
        headers: { "content-type": "application/json", ...headers },
      });
    },
  });
  return { provider, requested };
}

function jinaEnvelope(content: string): string {
  return JSON.stringify({ code: 200, status: 200, data: { content } });
}

const input = { query: "bun test runner", numResults: 5 };

describe("DuckDuckGoProvider", () => {
  test("parses lite serp results and unwraps redirect links", async () => {
    const { provider } = providerWith(200, jinaEnvelope(SERP));

    expect(await provider.search(input)).toEqual([
      {
        title: "Test runner - Bun",
        url: "https://bun.com/docs/test",
        snippet: "Bun's fast, built-in, Jest-compatible testrunner",
      },
      {
        title: "Welcome to Bun",
        url: "https://bun.com/docs",
        snippet: "Bun ships as a single, dependency-free binary.",
      },
    ]);
  });

  test("reads the search target through the reader endpoint", async () => {
    const { provider, requested } = providerWith(200, jinaEnvelope(SERP));

    await provider.search(input);

    expect(requested[0]).toBe(
      `https://r.jina.ai/${encodeURIComponent(
        "https://lite.duckduckgo.com/lite/?q=bun%20test%20runner"
      )}`
    );
  });

  test("honours the requested result count", async () => {
    const { provider } = providerWith(200, jinaEnvelope(SERP));

    expect(await provider.search({ ...input, numResults: 1 })).toHaveLength(1);
  });

  test("accepts a plain-text reader response", async () => {
    const { provider } = providerWith(200, SERP);

    expect(await provider.search(input)).toHaveLength(2);
  });

  test("treats an unparseable page as a failure rather than an empty answer", async () => {
    const { provider } = providerWith(
      200,
      jinaEnvelope("Unfortunately, bots use DuckDuckGo too.")
    );

    expect(provider.search(input)).rejects.toThrow("bot-blocked");
  });

  test("accepts a genuine empty result page", async () => {
    const { provider } = providerWith(
      200,
      jinaEnvelope("No results found for that query.")
    );

    expect(await provider.search(input)).toEqual([]);
  });

  test("raises a quota error on 429", async () => {
    const { provider } = providerWith(429, "{}", { "retry-after": "30" });

    const error = await provider.search(input).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderQuotaError);
    expect((error as ProviderQuotaError).retryAfterMs).toBe(30_000);
  });

  test("keeps a result whose snippet is a single domain line", async () => {
    const { provider } = providerWith(
      200,
      jinaEnvelope(`1.[Bare](${redirect("https://bare.test")})\nbare.test`)
    );

    expect(await provider.search(input)).toEqual([
      { title: "Bare", url: "https://bare.test", snippet: "" },
    ]);
  });
});
