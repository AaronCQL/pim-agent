import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { OutputBudget } from "../../shared/OutputBudget";
import { AnsiPainter } from "../../view/AnsiPainter";
import type { GrepMatch } from "./grep";
import { buildView, formatTitle, renderMatches } from "./render";

// Marks every themed span so an assertion catches colour the old renderer
// never emitted.
const markerTheme = {
  bold: (text: string) => text,
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
} as unknown as Theme;

function paintBody(input: Parameters<typeof buildView>[0]): string {
  return AnsiPainter.paint(buildView(input).body ?? [], markerTheme).join("\n");
}

const fixture: readonly GrepMatch[] = [
  {
    filePath: "/repo/older.ts",
    mtime: 1_000,
    fileLines: ["alpha"],
    ranges: [{ startLineNumber: 1, endLineNumber: 1 }],
    lines: [{ lineNumber: 1, text: "alpha" }],
  },
  {
    filePath: "/repo/newer.ts",
    mtime: 2_000,
    fileLines: ["intro", "alpha", "middle", "tail", "alphabet"],
    ranges: [
      { startLineNumber: 2, endLineNumber: 2 },
      { startLineNumber: 5, endLineNumber: 5 },
    ],
    lines: [
      { lineNumber: 2, text: "alpha" },
      { lineNumber: 5, text: "alphabet" },
    ],
  },
];

const relativeOptions = {
  cwd: "/repo",
  pathFormat: "relative",
  context: 0,
} as const;

const absoluteOptions = {
  cwd: "/repo",
  pathFormat: "absolute",
  context: 0,
} as const;

describe("renderMatches", () => {
  test("files_with_matches sorts by recency desc and renders relative paths", () => {
    const outcome = renderMatches(
      fixture,
      "files_with_matches",
      1000,
      relativeOptions
    );
    expect(outcome.body).toBe("newer.ts\nolder.ts");
    expect(outcome.fileCount).toBe(2);
    expect(outcome.totalMatches).toBe(3);
    expect(outcome.totalItems).toBe(2);
    expect(outcome.truncated).toBe(false);
  });

  test("can render absolute paths", () => {
    const outcome = renderMatches(
      fixture,
      "files_with_matches",
      1000,
      absoluteOptions
    );
    expect(outcome.body).toBe("/repo/newer.ts\n/repo/older.ts");
  });

  test("content emits path:line:text lines without markers when context is omitted", () => {
    const outcome = renderMatches(fixture, "content", 1000, relativeOptions);
    expect(outcome.body).toBe(
      ["newer.ts:2:alpha", "newer.ts:5:alphabet", "older.ts:1:alpha"].join("\n")
    );
    expect(outcome.totalItems).toBe(3);
  });

  test("content can include context lines and distinguish matches", () => {
    const outcome = renderMatches(fixture, "content", 1000, {
      ...relativeOptions,
      context: 1,
    });
    expect(outcome.body).toBe(
      [
        "  newer.ts:1:intro",
        "> newer.ts:2:alpha",
        "  newer.ts:3:middle",
        "  newer.ts:4:tail",
        "> newer.ts:5:alphabet",
        "> older.ts:1:alpha",
      ].join("\n")
    );
  });

  test("content inserts separators between non-overlapping context blocks", () => {
    const outcome = renderMatches(
      [
        {
          filePath: "/repo/gapped.ts",
          mtime: 3_000,
          fileLines: ["1", "2", "hit", "4", "5", "6", "hit", "8", "9"],
          ranges: [
            { startLineNumber: 3, endLineNumber: 3 },
            { startLineNumber: 7, endLineNumber: 7 },
          ],
          lines: [
            { lineNumber: 3, text: "hit" },
            { lineNumber: 7, text: "hit" },
          ],
        },
      ],
      "content",
      1000,
      { ...relativeOptions, context: 1 }
    );

    expect(outcome.body).toBe(
      [
        "  gapped.ts:2:2",
        "> gapped.ts:3:hit",
        "  gapped.ts:4:4",
        "--",
        "  gapped.ts:6:6",
        "> gapped.ts:7:hit",
        "  gapped.ts:8:8",
      ].join("\n")
    );
  });

  test("count sorts by match count desc, then mtime desc, then path asc", () => {
    const outcome = renderMatches(fixture, "count", 1000, relativeOptions);
    expect(outcome.body).toBe("newer.ts:2\nolder.ts:1");
  });

  test("flags truncation when results exceed headLimit", () => {
    const outcome = renderMatches(fixture, "content", 2, relativeOptions);
    expect(outcome.body).toBe("newer.ts:2:alpha\nnewer.ts:5:alphabet");
    expect(outcome.truncated).toBe(true);
    expect(outcome.visibleItems).toBe(2);
    expect(outcome.totalItems).toBe(3);
  });

  test("returns a no-match outcome when there are no results", () => {
    const outcome = renderMatches([], "content", 1000, relativeOptions);
    expect(outcome.body).toBe("No matches.");
    expect(outcome.truncated).toBe(false);
    expect(outcome.fileCount).toBe(0);
    expect(outcome.totalMatches).toBe(0);
  });

  test("truncates matched lines from minified files so a single hit cannot blow up the body", () => {
    const minified = "a".repeat(50_000);
    const outcome = renderMatches(
      [
        {
          filePath: "/repo/dist/bundle.js",
          mtime: 1_000,
          fileLines: [minified],
          ranges: [{ startLineNumber: 1, endLineNumber: 1 }],
          lines: [{ lineNumber: 1, text: minified }],
        },
      ],
      "content",
      1000,
      relativeOptions
    );

    expect(outcome.body).toContain(
      `(line truncated to ${OutputBudget.maxLineLength} chars)`
    );
    expect(Buffer.byteLength(outcome.body, "utf8")).toBeLessThanOrEqual(
      OutputBudget.maxBytes
    );
  });

  test("byte cap drops trailing rendered lines when many matches each push toward the cap", () => {
    const longText = "x".repeat(OutputBudget.maxLineLength);
    const fileLines = Array.from({ length: 40 }, () => longText);
    const ranges = fileLines.map((_, index) => ({
      startLineNumber: index + 1,
      endLineNumber: index + 1,
    }));
    const lines = fileLines.map((text, index) => ({
      lineNumber: index + 1,
      text,
    }));

    const outcome = renderMatches(
      [
        {
          filePath: "/repo/big.txt",
          mtime: 1_000,
          fileLines,
          ranges,
          lines,
        },
      ],
      "content",
      1000,
      relativeOptions
    );

    expect(outcome.truncated).toBe(true);
    expect(outcome.visibleItems).toBeLessThan(outcome.totalItems);
    expect(Buffer.byteLength(outcome.body, "utf8")).toBeLessThanOrEqual(
      OutputBudget.maxBytes
    );
  });
});

describe("buildView", () => {
  const base = { args: { pattern: "alpha" }, cwd: "/repo" } as const;

  test("supplies the title-cased display label", () => {
    expect(buildView({ ...base, body: "" }).label).toBe("Grep");
  });

  test("titles from args alone while the call is in flight", () => {
    const view = buildView({ args: { path: "src" }, body: "", cwd: "/repo" });
    expect(AnsiPainter.paint(view.title, markerTheme).join(" ")).toBe(
      "... in src"
    );
  });

  test("titles with the file count once the result settles", () => {
    const view = buildView({
      ...base,
      body: "a.ts",
      details: { outputMode: "files_with_matches", fileCount: 1 },
    });
    expect(AnsiPainter.paint(view.title, markerTheme).join(" ")).toBe(
      "/alpha/ (1 file)"
    );
  });

  test("files_with_matches paints one bare path per row", () => {
    expect(
      paintBody({
        ...base,
        body: "newer.ts\nolder.ts",
        details: { outputMode: "files_with_matches" },
      })
    ).toBe("newer.ts\nolder.ts");
  });

  test("content and count keep the rendered body verbatim", () => {
    const content = "  a.ts:1:intro\n> a.ts:2:alpha\n--\n> a.ts:9:alpha";
    expect(
      paintBody({ ...base, body: content, details: { outputMode: "content" } })
    ).toBe(content);
    expect(
      paintBody({
        ...base,
        body: "a.ts:2\nb.ts:1",
        details: { outputMode: "count" },
      })
    ).toBe("a.ts:2\nb.ts:1");
  });

  test("a no-match body stays text rather than becoming a bogus path", () => {
    const view = buildView({
      ...base,
      body: "No matches.",
      details: { outputMode: "files_with_matches" },
    });
    expect(view.body).toEqual([{ kind: "text", text: "No matches." }]);
  });

  test("falls back to text when a persisted entry has no details", () => {
    expect(paintBody({ ...base, body: "a.ts\nb.ts" })).toBe("a.ts\nb.ts");
  });
});

describe("formatTitle", () => {
  test("uses relative path under cwd and includes glob", () => {
    const title = formatTitle({
      pattern: "alpha",
      path: "/repo/src",
      glob: "**/*.ts",
      cwd: "/repo",
    });
    expect(title).toBe("/alpha/ in src/**/*.ts");
  });

  test("formats regex patterns with slashes", () => {
    const title = formatTitle({
      pattern: "^alpha$",
      path: "/repo/src",
      glob: undefined,
      cwd: "/repo",
    });
    expect(title).toBe("/^alpha$/ in src");
  });

  test("omits location when path is omitted", () => {
    const title = formatTitle({
      pattern: "alpha",
      path: undefined,
      glob: undefined,
      cwd: "/repo",
    });
    expect(title).toBe("/alpha/");
  });

  test("shows glob alone when path is omitted", () => {
    const title = formatTitle({
      pattern: "alpha",
      path: undefined,
      glob: "{src,docs}/**/*.ts",
      cwd: "/repo",
    });
    expect(title).toBe("/alpha/ in {src,docs}/**/*.ts");
  });

  test("resolves relative paths in titles", () => {
    const title = formatTitle({
      pattern: "alpha",
      path: "src",
      glob: undefined,
      cwd: "/repo",
    });
    expect(title).toBe("/alpha/ in src");
  });

  test("appends pluralized file count when provided", () => {
    const title = formatTitle({
      pattern: "alpha",
      path: "/repo/src",
      glob: "**/*.ts",
      cwd: "/repo",
      fileCount: 3,
    });
    expect(title).toBe("/alpha/ in src/**/*.ts (3 files)");
  });

  test("uses singular noun for a single file", () => {
    const title = formatTitle({
      pattern: "alpha",
      path: undefined,
      glob: undefined,
      cwd: "/repo",
      fileCount: 1,
    });
    expect(title).toBe("/alpha/ (1 file)");
  });
});
