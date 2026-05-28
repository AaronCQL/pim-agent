import { describe, expect, test } from "bun:test";
import {
  clampMaxBytes,
  executeFetch,
  formatOutcome,
  validatePublicUrl,
} from "./fetch";
import {
  DEFAULT_FETCH_BYTES,
  MAX_FETCH_BYTES,
  MIN_FETCH_BYTES,
} from "./schema";
import type { JinaReaderClient } from "./JinaReaderClient";
import type { WebViewFetchClient } from "./WebViewFetchClient";

describe("clampMaxBytes", () => {
  test("defaults when undefined", () => {
    expect(clampMaxBytes(undefined)).toBe(DEFAULT_FETCH_BYTES);
  });

  test("clamps below minimum", () => {
    expect(clampMaxBytes(0)).toBe(MIN_FETCH_BYTES);
  });

  test("clamps above maximum", () => {
    expect(clampMaxBytes(MAX_FETCH_BYTES * 4)).toBe(MAX_FETCH_BYTES);
  });

  test("passes through valid values", () => {
    expect(clampMaxBytes(8 * 1024)).toBe(8 * 1024);
  });
});

describe("validatePublicUrl", () => {
  test("accepts http and https", () => {
    expect(validatePublicUrl("https://example.com/path")).toBe(
      "https://example.com/path"
    );
    expect(validatePublicUrl("http://example.com")).toBe("http://example.com/");
  });

  test("rejects non-http schemes", () => {
    expect(() => validatePublicUrl("ftp://example.com")).toThrow(/http/);
    expect(() => validatePublicUrl("file:///etc/passwd")).toThrow(/http/);
  });

  test("rejects malformed URLs", () => {
    expect(() => validatePublicUrl("not a url")).toThrow(/valid/);
  });

  test("rejects embedded credentials", () => {
    expect(() => validatePublicUrl("https://user:pw@example.com")).toThrow(
      /credentials/
    );
  });

  test("rejects localhost and .local", () => {
    expect(() => validatePublicUrl("http://localhost/")).toThrow(/public/);
    expect(() => validatePublicUrl("http://printer.local/")).toThrow(/public/);
  });

  test("rejects RFC1918 IPv4", () => {
    expect(() => validatePublicUrl("http://10.0.0.1/")).toThrow(/public/);
    expect(() => validatePublicUrl("http://192.168.1.1/")).toThrow(/public/);
    expect(() => validatePublicUrl("http://172.16.0.1/")).toThrow(/public/);
    expect(() => validatePublicUrl("http://127.0.0.1/")).toThrow(/public/);
    expect(() => validatePublicUrl("http://169.254.0.1/")).toThrow(/public/);
  });

  test("rejects IPv6 loopback and link-local", () => {
    expect(() => validatePublicUrl("http://[::1]/")).toThrow(/public/);
    expect(() => validatePublicUrl("http://[fe80::1]/")).toThrow(/public/);
    expect(() => validatePublicUrl("http://[fc00::1]/")).toThrow(/public/);
  });

  test("accepts public IPs", () => {
    expect(validatePublicUrl("http://8.8.8.8/")).toBe("http://8.8.8.8/");
  });
});

describe("executeFetch", () => {
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

    const outcome = await executeFetch({
      jina,
      webView,
      url: "https://example.test/",
      maxBytes: 1024,
      format: "markdown",
    });

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

    const outcome = await executeFetch({
      jina,
      webView,
      url: "https://example.test/",
      maxBytes: 1024,
      format: "markdown",
    });

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
        maxBytes: 1024,
        format: "markdown",
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

    const outcome = await executeFetch({
      jina,
      webView,
      url: "https://example.test/",
      maxBytes: 1024,
      format: "html",
    });

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

  test("formats untruncated page", () => {
    const outcome = formatOutcome(page, 1024, "markdown");
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
  });

  test("appends truncation footer when over cap", () => {
    const long = { ...page, content: "x".repeat(2000) };
    const outcome = formatOutcome(long, 100, "html");
    expect(outcome.truncated).toBe(true);
    expect(outcome.returnedBytes).toBe(100);
    expect(outcome.totalBytes).toBe(2000);
    expect(outcome.text).toContain(
      "[web_fetch tool: truncated — kept first 100 bytes of 2000;"
    );
    expect(outcome.text).toContain(`cap ${MAX_FETCH_BYTES}`);
  });
});
