import { describe, expect, test } from "bun:test";
import { DiffLines, type ToolDiffSide } from "./DiffLines";

const side = (
  lines: readonly string[],
  hasTrailingNewline = true
): ToolDiffSide => ({
  lines,
  hasTrailingNewline,
});

describe("DiffLines.buildToolDiff", () => {
  test("returns undefined when content and EOF state are identical", () => {
    const result = DiffLines.buildToolDiff(
      "/tmp/x.ts",
      side(["alpha", "beta", "gamma"]),
      side(["alpha", "beta", "gamma"]),
      2
    );
    expect(result).toBeUndefined();
  });

  test("captures a single-line modification with surrounding context", () => {
    const result = DiffLines.buildToolDiff(
      "/tmp/x.ts",
      side(["alpha", "beta", "gamma"]),
      side(["alpha", "BETA", "gamma"]),
      2
    );
    expect(result).toBeDefined();
    const hunk = result?.hunks[0];
    expect(hunk).toBeDefined();
    expect(hunk?.lines.map((line) => line.kind)).toEqual([
      "context",
      "removed",
      "added",
      "context",
    ]);
    expect(hunk?.lines.map((line) => line.text)).toEqual([
      "alpha",
      "beta",
      "BETA",
      "gamma",
    ]);
  });

  test("represents an all-added diff for a brand-new file", () => {
    const result = DiffLines.buildToolDiff(
      "/tmp/new.ts",
      side([], false),
      side(["alpha", "beta"]),
      2
    );
    const hunk = result?.hunks[0];
    expect(hunk?.lines.map((line) => line.kind)).toEqual(["added", "added"]);
  });

  test("collapses far-apart changes into separate hunks", () => {
    const oldLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const newLines = oldLines.slice();
    newLines[1] = "EARLY";
    newLines[18] = "LATE";

    const result = DiffLines.buildToolDiff(
      "/tmp/x.ts",
      side(oldLines),
      side(newLines),
      1
    );
    expect(result?.hunks.length).toBe(2);
  });

  test("attaches intra-line emphasis to a paired removed/added line", () => {
    const result = DiffLines.buildToolDiff(
      "/tmp/x.ts",
      side(["const x = 1;"]),
      side(["const y = 2;"]),
      1
    );
    const lines = result?.hunks[0]?.lines ?? [];
    const removed = lines.find((line) => line.kind === "removed");
    const added = lines.find((line) => line.kind === "added");

    expect(removed?.emphasis?.length ?? 0).toBeGreaterThan(0);
    expect(added?.emphasis?.length ?? 0).toBeGreaterThan(0);

    for (const range of removed?.emphasis ?? []) {
      const slice = removed?.text.slice(range.start, range.end) ?? "";
      expect(slice.includes("x") || slice.includes("1")).toBe(true);
    }
  });

  test("skips emphasis when removed and added runs are unequal length", () => {
    const result = DiffLines.buildToolDiff(
      "/tmp/x.ts",
      side(["alpha"]),
      side(["beta", "gamma"]),
      1
    );
    const lines = result?.hunks[0]?.lines ?? [];

    for (const line of lines) {
      expect(line.emphasis).toBeUndefined();
    }
  });

  test("does not emphasize leading whitespace", () => {
    const result = DiffLines.buildToolDiff(
      "/tmp/x.ts",
      side(["  foo();"]),
      side(["    foo();"]),
      1
    );
    const lines = result?.hunks[0]?.lines ?? [];

    for (const line of lines) {
      for (const range of line.emphasis ?? []) {
        const slice = line.text.slice(range.start, range.end);
        expect(/^\s/.test(slice)).toBe(false);
      }
    }
  });

  test("skips emphasis when lines share no content", () => {
    const result = DiffLines.buildToolDiff(
      "/tmp/x.ts",
      side(["foo"]),
      side(["bar"]),
      1
    );
    const lines = result?.hunks[0]?.lines ?? [];

    for (const line of lines) {
      expect(line.emphasis).toBeUndefined();
    }
  });

  test("returns undefined when only EOF newline state differs (callers surface EOF themselves)", () => {
    const result = DiffLines.buildToolDiff(
      "/tmp/x.ts",
      side(["alpha"], true),
      side(["alpha"], false),
      2
    );
    expect(result).toBeUndefined();
  });

  test("does not emit a phantom empty added line when appending to a newline-terminated file", () => {
    const result = DiffLines.buildToolDiff(
      "/tmp/x.ts",
      side(["foo", "bar"], true),
      side(["foo", "bar", "baz"], true),
      1
    );
    const lines = result?.hunks[0]?.lines ?? [];
    const added = lines.filter((line) => line.kind === "added");
    expect(added).toHaveLength(1);
    expect(added[0]?.text).toBe("baz");
  });

  test("throws on negative contextSize", () => {
    expect(() =>
      DiffLines.buildToolDiff("/tmp/x.ts", side(["a"]), side(["b"]), -1)
    ).toThrow();
  });
});

describe("DiffLines.fromText", () => {
  test("treats the empty string as zero lines, no trailing newline", () => {
    expect(DiffLines.fromText("")).toEqual({
      lines: [],
      hasTrailingNewline: false,
    });
  });

  test("distinguishes 'a' from 'a\\n'", () => {
    expect(DiffLines.fromText("a")).toEqual({
      lines: ["a"],
      hasTrailingNewline: false,
    });
    expect(DiffLines.fromText("a\n")).toEqual({
      lines: ["a"],
      hasTrailingNewline: true,
    });
  });

  test("preserves embedded blank lines without collapsing them", () => {
    expect(DiffLines.fromText("a\n\nb\n")).toEqual({
      lines: ["a", "", "b"],
      hasTrailingNewline: true,
    });
  });
});
