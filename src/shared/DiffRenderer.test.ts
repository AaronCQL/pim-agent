import { describe, expect, test } from "bun:test";
import { DiffLines, type ToolDiffHunk } from "./DiffLines";
import { DiffRenderer, type DiffHighlighter } from "./DiffRenderer";

const tagHighlighter: DiffHighlighter = (block) =>
  block.split("\n").map((line) => `<H>${line}</H>`);

const recordingHighlighter = (calls: string[][]): DiffHighlighter => {
  return (block) => {
    const lines = block.split("\n");
    calls.push(lines);
    return lines.map((line) => `<H>${line}</H>`);
  };
};

const firstHunk = (
  oldText: readonly string[],
  newText: readonly string[]
): ToolDiffHunk => {
  const diff = DiffLines.buildToolDiff("foo.ts", oldText, newText, 1);

  if (diff === undefined || diff.hunks[0] === undefined) {
    throw new Error("expected at least one hunk");
  }

  return diff.hunks[0];
};

describe("DiffRenderer.highlightHunkLines", () => {
  test("highlights added lines using the new-side block", () => {
    const hunk = firstHunk(["a", "b", "c"], ["a", "b", "c", "d"]);
    const result = DiffRenderer.highlightHunkLines(hunk, tagHighlighter);

    expect(result).toEqual(hunk.lines.map((line) => `<H>${line.text}</H>`));
  });

  test("highlights removed lines using the old-side block", () => {
    const hunk = firstHunk(["a", "b", "c"], ["a", "c"]);
    const result = DiffRenderer.highlightHunkLines(hunk, tagHighlighter);

    expect(result).toEqual(hunk.lines.map((line) => `<H>${line.text}</H>`));
  });

  test("passes old and new versions as multi-line blocks (not per line)", () => {
    const hunk = firstHunk(
      ["line1", "old-mid", "line3"],
      ["line1", "new-mid", "line3"]
    );
    const calls: string[][] = [];
    DiffRenderer.highlightHunkLines(hunk, recordingHighlighter(calls));

    expect(calls).toHaveLength(2);
    expect(calls).toContainEqual(["line1", "old-mid", "line3"]);
    expect(calls).toContainEqual(["line1", "new-mid", "line3"]);
  });

  test("maps each diff line to the correct highlighted entry", () => {
    const hunk = firstHunk(
      ["keep", "drop1", "drop2", "tail"],
      ["keep", "add1", "add2", "tail"]
    );
    const result = DiffRenderer.highlightHunkLines(hunk, tagHighlighter);

    for (let i = 0; i < hunk.lines.length; i += 1) {
      expect(result[i]).toBe(`<H>${hunk.lines[i]?.text}</H>`);
    }
  });

  test("falls back to raw text when highlighter returns shorter array", () => {
    const hunk = firstHunk(["a"], ["a", "b"]);
    const truncating: DiffHighlighter = () => [];
    const result = DiffRenderer.highlightHunkLines(hunk, truncating);

    expect(result).toEqual(hunk.lines.map((line) => line.text));
  });

  test("skips highlighter calls when one side is empty", () => {
    const hunk = firstHunk(["a", "b"], ["a", "b", "c", "d"]);
    const calls: string[][] = [];
    DiffRenderer.highlightHunkLines(hunk, recordingHighlighter(calls));

    for (const call of calls) {
      expect(call.length).toBeGreaterThan(0);
    }
  });
});

describe("DiffRenderer.render", () => {
  const stubTheme = {
    name: "pim-dark",
    fg: (_color: string, text: string) => text,
  } as unknown as Parameters<typeof DiffRenderer.render>[0]["theme"];

  test("returns empty string for empty diff", () => {
    const out = DiffRenderer.render({
      toolDiff: { path: "foo.ts", hunks: [] },
      theme: stubTheme,
    });
    expect(out).toBe("");
  });

  test("includes content for each diff line", () => {
    const diff = DiffLines.buildToolDiff(
      "foo.ts",
      ["alpha", "beta", "gamma"],
      ["alpha", "BETA", "gamma"],
      1
    );

    if (diff === undefined) {
      throw new Error("expected diff");
    }

    const out = DiffRenderer.render({ toolDiff: diff, theme: stubTheme });

    expect(out).toContain("alpha");
    expect(out).toContain("beta");
    expect(out).toContain("BETA");
    expect(out).toContain("gamma");
  });

  test("emits emphasis bg for paired changed lines", () => {
    const diff = DiffLines.buildToolDiff(
      "foo.ts",
      ["const x = 1;"],
      ["const y = 2;"],
      1
    );

    if (diff === undefined) {
      throw new Error("expected diff");
    }

    const out = DiffRenderer.render({ toolDiff: diff, theme: stubTheme });

    expect(out).toContain("\x1b[48;2;31;102;58m");
    expect(out).toContain("\x1b[48;2;110;36;36m");
  });
});

describe("DiffRenderer.applyEmphasis", () => {
  const lineBg = "\x1b[48;2;0;0;0m";
  const emphBg = "\x1b[48;2;255;255;255m";

  test("returns text unchanged when no ranges", () => {
    expect(DiffRenderer.applyEmphasis("hello", [], lineBg, emphBg)).toBe(
      "hello"
    );
  });

  test("wraps an emphasized range with emph then line bg", () => {
    const out = DiffRenderer.applyEmphasis(
      "hello world",
      [{ start: 6, end: 11 }],
      lineBg,
      emphBg
    );
    expect(out).toBe(`hello ${emphBg}world${lineBg}`);
  });

  test("counts visible chars only, ignoring ANSI escape sequences", () => {
    const colored = `\x1b[31mhello\x1b[39m world`;
    const out = DiffRenderer.applyEmphasis(
      colored,
      [{ start: 6, end: 11 }],
      lineBg,
      emphBg
    );
    expect(out).toBe(`\x1b[31mhello\x1b[39m ${emphBg}world${lineBg}`);
  });

  test("supports multiple non-overlapping ranges", () => {
    const out = DiffRenderer.applyEmphasis(
      "abcdef",
      [
        { start: 0, end: 2 },
        { start: 4, end: 6 },
      ],
      lineBg,
      emphBg
    );
    expect(out).toBe(`${emphBg}ab${lineBg}cd${emphBg}ef${lineBg}`);
  });
});
