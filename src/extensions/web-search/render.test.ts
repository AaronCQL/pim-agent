import { describe, expect, test } from "bun:test";
import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { AnsiPainter } from "../../shared/view/AnsiPainter";
import { webSearchView } from "./render";
import {
  DEFAULT_NUM_RESULTS,
  type WebSearchDetails,
  type WebSearchInput,
} from "./schema";

const stubTheme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

function result(
  body: string,
  details: Partial<WebSearchDetails> = {}
): AgentToolResult<WebSearchDetails> {
  return {
    content: [{ type: "text", text: body }],
    details: details as WebSearchDetails,
  };
}

function title(
  args: Partial<WebSearchInput>,
  settled?: AgentToolResult<WebSearchDetails>
): string {
  const view = webSearchView({
    args: args as WebSearchInput,
    ...(settled === undefined ? {} : { result: settled }),
    cwd: "/repo",
    isPartial: false,
  });
  return AnsiPainter.paint(view.title, stubTheme).join(" ");
}

describe("webSearchView title", () => {
  test("supplies the title-cased display label", () => {
    expect(
      webSearchView({
        args: {} as WebSearchInput,
        cwd: "/repo",
        isPartial: false,
      }).label
    ).toBe("Web Search");
  });

  test("always includes the default count in parentheses", () => {
    expect(title({ query: "bun release notes" })).toBe(
      `bun release notes (${DEFAULT_NUM_RESULTS})`
    );
  });

  test("includes explicit counts in parentheses", () => {
    expect(title({ query: "pi agent", numResults: 3 })).toBe("pi agent (3)");
  });

  test("clamps out-of-range counts before the result lands", () => {
    expect(title({ query: "pi agent", numResults: 99 })).toBe("pi agent (10)");
  });

  test("uses a placeholder while keeping the count visible", () => {
    expect(title({})).toBe(`... (${DEFAULT_NUM_RESULTS})`);
  });

  test("names the provider once it is known", () => {
    expect(
      title(
        { query: "pi agent", numResults: 3 },
        result("hits", { count: 3, provider: "firecrawl" })
      )
    ).toBe("pi agent (3 · firecrawl)");
  });

  test("shows the delivered count, not the requested one", () => {
    expect(
      title(
        { query: "pi agent", numResults: 10 },
        result("hits", { count: 2, provider: "duckduckgo", fellBack: true })
      )
    ).toBe("pi agent (2 · duckduckgo)");
  });

  test("falls back to the requested count when details lack one", () => {
    expect(
      title(
        { query: "pi agent", numResults: 2 },
        result("hits", { provider: "exa" })
      )
    ).toBe("pi agent (2 · exa)");
  });
});

describe("webSearchView body", () => {
  function body(settled: AgentToolResult<WebSearchDetails>): string[] {
    const view = webSearchView({
      args: { query: "pi agent" } as WebSearchInput,
      result: settled,
      cwd: "/repo",
      isPartial: false,
    });
    return AnsiPainter.paint(view.body ?? [], stubTheme);
  }

  test("renders the formatted results verbatim", () => {
    expect(body(result("title: a\nurl: b\nsnippet: c"))).toEqual([
      "title: a",
      "url: b",
      "snippet: c",
    ]);
  });

  test("omits an empty body", () => {
    expect(body(result(""))).toEqual([]);
  });
});
