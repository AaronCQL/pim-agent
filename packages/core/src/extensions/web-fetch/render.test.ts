import { describe, expect, test } from "bun:test";
import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { AnsiPainter } from "../../view/AnsiPainter";
import { webFetchView } from "./render";
import type { WebFetchDetails, WebFetchInput } from "./schema";

const stubTheme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

function result(
  body: string,
  details: Partial<WebFetchDetails> = {}
): AgentToolResult<WebFetchDetails> {
  return {
    content: [{ type: "text", text: body }],
    details: details as WebFetchDetails,
  };
}

function title(
  args: Partial<WebFetchInput>,
  settled?: AgentToolResult<WebFetchDetails>
): string {
  const view = webFetchView({
    args: args as WebFetchInput,
    ...(settled === undefined ? {} : { result: settled }),
    cwd: "/repo",
    isPartial: false,
  });
  return AnsiPainter.paint(view.title, stubTheme).join(" ");
}

function body(settled: AgentToolResult<WebFetchDetails>): string[] {
  const view = webFetchView({
    args: { url: "https://example.com" } as WebFetchInput,
    result: settled,
    cwd: "/repo",
    isPartial: false,
  });
  return AnsiPainter.paint(view.body ?? [], stubTheme);
}

describe("webFetchView title", () => {
  test("supplies the title-cased display label", () => {
    expect(
      webFetchView({
        args: {} as WebFetchInput,
        cwd: "/repo",
        isPartial: false,
      }).label
    ).toBe("Web Fetch");
  });

  test("returns placeholder and default format when url is undefined", () => {
    expect(title({})).toBe("... (Markdown)");
  });

  test("renders default markdown pre-result", () => {
    expect(title({ url: "https://example.com" })).toBe(
      "https://example.com (Markdown)"
    );
  });

  test("renders requested HTML pre-result", () => {
    expect(title({ url: "https://example.com", format: "html" })).toBe(
      "https://example.com (HTML)"
    );
  });

  test("renders size + format label after result arrives", () => {
    expect(
      title(
        { url: "https://example.com" },
        result("body", { format: "markdown", totalBytes: 23 * 1024 })
      )
    ).toBe("https://example.com (23KB Markdown)");
  });

  test("strips trailing zeros and supports two decimals", () => {
    expect(
      title(
        { url: "https://example.com" },
        result("body", { format: "html", totalBytes: 5355 })
      )
    ).toBe("https://example.com (5.23KB HTML)");
  });

  test("renders bytes for tiny payloads", () => {
    expect(
      title(
        { url: "https://example.com" },
        result("body", { format: "markdown", totalBytes: 512 })
      )
    ).toBe("https://example.com (512B Markdown)");
  });

  test("renders MB for large payloads", () => {
    expect(
      title(
        { url: "https://example.com" },
        result("body", { format: "html", totalBytes: 2.5 * 1024 * 1024 })
      )
    ).toBe("https://example.com (2.5MB HTML)");
  });

  test("keeps the requested format when details are incomplete", () => {
    expect(
      title(
        { url: "https://example.com", format: "html" },
        result("body", { url: "https://example.com" })
      )
    ).toBe("https://example.com (HTML)");
  });

  test("ignores the page title, which never reached the row", () => {
    expect(
      title(
        { url: "https://example.com" },
        result("body", {
          title: "Example Domain",
          format: "markdown",
          totalBytes: 512,
        })
      )
    ).toBe("https://example.com (512B Markdown)");
  });
});

describe("webFetchView body", () => {
  test("renders the fetched text verbatim", () => {
    expect(body(result("# Title\n\nparagraph"))).toEqual([
      "# Title",
      "",
      "paragraph",
    ]);
  });

  test("omits an empty body", () => {
    expect(body(result(""))).toEqual([]);
  });
});
