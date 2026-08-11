import { describe, expect, test } from "bun:test";

import { FirecrawlProvider } from "./FirecrawlProvider";
import { ProviderQuotaError, ProviderSearchError } from "./SearchProvider";

type Captured = { request?: Request };

function providerWith(
  status: number,
  body: string,
  headers: Record<string, string> = {}
): { provider: FirecrawlProvider; captured: Captured } {
  const captured: Captured = {};
  const provider = new FirecrawlProvider({
    fetch: async (input, init) => {
      captured.request = new Request(input as never, init as never);
      return new Response(body, {
        status,
        headers: { "content-type": "application/json", ...headers },
      });
    },
  });
  return { provider, captured };
}

const input = { query: "bun test runner", numResults: 3 };

describe("FirecrawlProvider", () => {
  test("projects results from the nested web array", async () => {
    const { provider } = providerWith(
      200,
      JSON.stringify({
        success: true,
        data: {
          web: [
            {
              url: "https://bun.com/docs/test",
              title: "Test runner - Bun",
              description: "Bun ships with a   fast test runner.",
              position: 1,
            },
          ],
        },
      })
    );

    expect(await provider.search(input)).toEqual([
      {
        title: "Test runner - Bun",
        url: "https://bun.com/docs/test",
        snippet: "Bun ships with a fast test runner.",
      },
    ]);
  });

  test("sends no authorization header when keyless", async () => {
    const { provider, captured } = providerWith(
      200,
      JSON.stringify({ success: true, data: { web: [] } })
    );

    await provider.search(input);

    expect(captured.request?.headers.get("authorization")).toBeNull();
  });

  test("authenticates when an api key is configured", async () => {
    const captured: Captured = {};
    const provider = new FirecrawlProvider({
      apiKey: "fc-test",
      fetch: async (url, init) => {
        captured.request = new Request(url as never, init as never);
        return new Response(
          JSON.stringify({ success: true, data: { web: [] } }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      },
    });

    await provider.search(input);

    expect(captured.request?.headers.get("authorization")).toBe(
      "Bearer fc-test"
    );
  });

  test("truncates the oversized descriptions firecrawl returns", async () => {
    const { provider } = providerWith(
      200,
      JSON.stringify({
        success: true,
        data: {
          web: [
            {
              url: "https://example.test",
              title: "Example",
              description: "x".repeat(2000),
            },
          ],
        },
      })
    );

    const [result] = await provider.search(input);

    expect(result?.snippet).toHaveLength(503);
    expect(result?.snippet.endsWith("...")).toBe(true);
  });

  test("falls back to the url when a title is missing", async () => {
    const { provider } = providerWith(
      200,
      JSON.stringify({
        success: true,
        data: { web: [{ url: "https://example.test" }] },
      })
    );

    expect((await provider.search(input))[0]?.title).toBe(
      "https://example.test"
    );
  });

  test("skips entries without a url", async () => {
    const { provider } = providerWith(
      200,
      JSON.stringify({
        success: true,
        data: { web: [{ title: "no url" }, { url: "https://ok.test" }] },
      })
    );

    expect(await provider.search(input)).toHaveLength(1);
  });

  test("raises a quota error on 429", async () => {
    const { provider } = providerWith(429, "{}", { "retry-after": "120" });

    const error = await provider.search(input).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderQuotaError);
    expect((error as ProviderQuotaError).retryAfterMs).toBe(120_000);
  });

  test("raises a plain search error on other http failures", async () => {
    const { provider } = providerWith(500, "{}");

    expect(provider.search(input)).rejects.toBeInstanceOf(ProviderSearchError);
  });

  test("raises a search error on malformed payloads", async () => {
    const { provider } = providerWith(200, JSON.stringify({ success: true }));

    expect(provider.search(input)).rejects.toThrow("malformed search results");
  });

  test("surfaces a reported failure", async () => {
    const { provider } = providerWith(
      200,
      JSON.stringify({ success: false, error: "not supported keyless" })
    );

    expect(provider.search(input)).rejects.toThrow("not supported keyless");
  });
});
