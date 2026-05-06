import { describe, expect, test } from "bun:test";
import { DiffLines } from "./DiffLines";

describe("DiffLines.buildToolDiff", () => {
  test("returns undefined when content is identical", () => {
    const result = DiffLines.buildToolDiff(
      "/tmp/x.ts",
      ["alpha", "beta", "gamma"],
      ["alpha", "beta", "gamma"],
      2
    );
    expect(result).toBeUndefined();
  });

  test("captures a single-line modification with surrounding context", () => {
    const result = DiffLines.buildToolDiff(
      "/tmp/x.ts",
      ["alpha", "beta", "gamma"],
      ["alpha", "BETA", "gamma"],
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
      [],
      ["alpha", "beta"],
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

    const result = DiffLines.buildToolDiff("/tmp/x.ts", oldLines, newLines, 1);
    expect(result?.hunks.length).toBe(2);
  });

  test("attaches intra-line emphasis to a paired removed/added line", () => {
    const result = DiffLines.buildToolDiff(
      "/tmp/x.ts",
      ["const x = 1;"],
      ["const y = 2;"],
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
      ["alpha"],
      ["beta", "gamma"],
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
      ["  foo();"],
      ["    foo();"],
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
    const result = DiffLines.buildToolDiff("/tmp/x.ts", ["foo"], ["bar"], 1);
    const lines = result?.hunks[0]?.lines ?? [];

    for (const line of lines) {
      expect(line.emphasis).toBeUndefined();
    }
  });
});
