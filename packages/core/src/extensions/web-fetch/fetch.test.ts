import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpillCache } from "../../shared/SpillCache";
import type { HttpFetch } from "../../shared/Http";
import {
  executeFetch,
  formatOutcome,
  truncationFooter,
  validatePublicUrl,
  type WebFetchOutcome,
  type WebFetchPageOutcome,
} from "./fetch";
import { WEB_FETCH_INLINE_BYTES } from "./schema";
import type { JinaReaderClient } from "./JinaReaderClient";
import type { WebViewFetchClient } from "./WebViewFetchClient";

let previousPimHomeDir: string | undefined;
let testPimHomeDir: string | undefined;

beforeAll(async () => {
  previousPimHomeDir = process.env.PIM_HOME_DIR;
  testPimHomeDir = await mkdtemp(join(tmpdir(), "pim-fetch-home-"));
  process.env.PIM_HOME_DIR = testPimHomeDir;
});

afterAll(async () => {
  if (previousPimHomeDir === undefined) {
    delete process.env.PIM_HOME_DIR;
  } else {
    process.env.PIM_HOME_DIR = previousPimHomeDir;
  }
  if (testPimHomeDir) {
    await rm(testPimHomeDir, { recursive: true, force: true });
  }
});

describe("validatePublicUrl", () => {
  test("accepts public http(s) URLs", () => {
    expect(validatePublicUrl("https://example.com/path")).toBe(
      "https://example.com/path"
    );
    expect(validatePublicUrl("http://example.com")).toBe("http://example.com/");
    expect(validatePublicUrl("http://8.8.8.8/")).toBe("http://8.8.8.8/");
  });

  test.each([
    ["ftp://example.com", /http/],
    ["file:///etc/passwd", /http/],
    ["not a url", /valid/],
    ["https://user:pw@example.com", /credentials/],
    ["http://localhost/", /public/],
    ["http://printer.local/", /public/],
    ["http://10.0.0.1/", /public/],
    ["http://192.168.1.1/", /public/],
    ["http://172.16.0.1/", /public/],
    ["http://127.0.0.1/", /public/],
    ["http://169.254.0.1/", /public/],
    ["http://[::1]/", /public/],
    ["http://[fe80::1]/", /public/],
    ["http://[fc00::1]/", /public/],
  ])("rejects %s", (url, message) => {
    expect(() => validatePublicUrl(url)).toThrow(message);
  });
});

describe("executeFetch", () => {
  // Answers the image probe with a non-image.
  const notAnImage: HttpFetch = async () =>
    new Response("<html>hello</html>", {
      headers: { "content-type": "text/html" },
    });

  function page(outcome: WebFetchOutcome): WebFetchPageOutcome {
    if (outcome.kind !== "page") {
      throw new Error(`expected a page outcome, got ${outcome.kind}`);
    }
    return outcome;
  }

  test("returns remote markdown when available", async () => {
    const jina = {
      fetchUrl: async () => ({
        title: "Remote",
        url: "https://example.test/remote",
        content: "remote markdown",
      }),
    } as unknown as JinaReaderClient;
    const webView = {
      fetchMarkdown: async () => {
        throw new Error("Rendered markdown should not be attempted.");
      },
    } as unknown as WebViewFetchClient;

    const outcome = page(
      await executeFetch({
        jina,
        webView,
        url: "https://example.test/",
        format: "markdown",
        fetch: notAnImage,
      })
    );

    expect(outcome.format).toBe("markdown");
    expect(outcome.text).toContain("remote markdown");
  });

  test("falls back to rendered markdown when remote markdown fails", async () => {
    const jina = {
      fetchUrl: async () => {
        throw new Error("Request timed out after 20000ms.");
      },
    } as unknown as JinaReaderClient;
    const webView = {
      fetchMarkdown: async () => ({
        title: "Rendered",
        url: "https://example.test/rendered",
        content: "# rendered markdown",
      }),
      fetchHtml: async () => {
        throw new Error("HTML should not be attempted for markdown mode.");
      },
    } as unknown as WebViewFetchClient;

    const outcome = page(
      await executeFetch({
        jina,
        webView,
        url: "https://example.test/",
        format: "markdown",
        fetch: notAnImage,
      })
    );

    expect(outcome.format).toBe("markdown");
    expect(outcome.text).toContain("# rendered markdown");
  });

  test("throws rendered markdown error when fallback fails", async () => {
    const jina = {
      fetchUrl: async () => {
        throw new Error("remote unavailable");
      },
    } as unknown as JinaReaderClient;
    const webView = {
      fetchMarkdown: async () => {
        throw new Error("Request failed: unavailable");
      },
    } as unknown as WebViewFetchClient;

    await expect(
      executeFetch({
        jina,
        webView,
        url: "https://example.test/",
        format: "markdown",
        fetch: notAnImage,
      })
    ).rejects.toThrow("Failed to fetch: Request failed: unavailable");
  });

  test("returns raw rendered HTML for HTML mode", async () => {
    const jina = {
      fetchUrl: async () => {
        throw new Error("Remote markdown should not be attempted.");
      },
    } as unknown as JinaReaderClient;
    const webView = {
      fetchHtml: async () => ({
        title: "HTML",
        url: "https://example.test/html",
        content: "<html><body>Hello</body></html>",
      }),
    } as unknown as WebViewFetchClient;

    const outcome = page(
      await executeFetch({
        jina,
        webView,
        url: "https://example.test/",
        format: "html",
        fetch: notAnImage,
      })
    );

    expect(outcome.format).toBe("html");
    expect(outcome.text).toContain("<html><body>Hello</body></html>");
  });
});

describe("formatOutcome", () => {
  const page = {
    title: "Example",
    url: "https://example.test/page",
    content: "hello world",
  };

  test("formats untruncated page without spilling", async () => {
    const outcome = await formatOutcome(page, "markdown");
    expect(outcome.text).toBe(
      [
        "title: Example",
        "url: https://example.test/page",
        "format: markdown",
        "content:",
        "hello world",
      ].join("\n")
    );
    expect(outcome.truncated).toBe(false);
    expect(outcome.returnedBytes).toBe(11);
    expect(outcome.totalBytes).toBe(11);
    expect(outcome.format).toBe("markdown");
    expect(outcome.path).toBeNull();
  });

  test("spills the full body and points the footer at the resume line over the inline budget", async () => {
    // 1 KiB lines: the 32 KiB head holds 32 of them.
    const line = `${"x".repeat(1023)}\n`;
    const content = line.repeat(40);
    const long = { ...page, content };
    const outcome = await formatOutcome(long, "html");
    expect(outcome.truncated).toBe(true);
    expect(outcome.returnedBytes).toBe(WEB_FETCH_INLINE_BYTES);
    expect(outcome.totalBytes).toBe(content.length);
    expect(outcome.path).toBeTruthy();
    expect(outcome.path!.startsWith(join(SpillCache.dir(), "fetch-"))).toBe(
      true
    );
    expect(outcome.path!.endsWith(".html")).toBe(true);
    expect(outcome.text).toContain(
      `use read with path=${outcome.path} and start=33 for the rest.]`
    );
    expect(await Bun.file(outcome.path!).text()).toBe(content);
  });
});

describe("truncationFooter", () => {
  test("signals the rest is unavailable when the spill failed", () => {
    expect(truncationFooter(100, 2000, null, 7)).toBe(
      "[web_fetch tool: showing first 100 bytes of 2000; full content unavailable.]"
    );
  });
});
