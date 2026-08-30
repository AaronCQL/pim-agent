import { describe, expect, test } from "bun:test";
import { DiffLines } from "./DiffLines";
import { DiffView } from "./DiffView";

describe("DiffView.countStats", () => {
  test("returns zeros when diff is undefined", () => {
    expect(DiffView.countStats(undefined)).toEqual({ added: 0, removed: 0 });
  });

  test("returns zeros for a diff with no hunks", () => {
    expect(DiffView.countStats({ path: "/tmp/x.ts", hunks: [] })).toEqual({
      added: 0,
      removed: 0,
    });
  });

  test("counts added and removed lines across hunks", () => {
    const diff = DiffLines.buildToolDiff(
      "/tmp/x.ts",
      {
        lines: ["alpha", "beta", "gamma", "delta"],
        hasTrailingNewline: true,
      },
      {
        lines: ["alpha", "BETA", "gamma", "DELTA"],
        hasTrailingNewline: true,
      },
      0
    );
    expect(diff?.hunks.length).toBeGreaterThan(1);
    expect(DiffView.countStats(diff)).toEqual({ added: 2, removed: 2 });
  });

  test("counts a brand-new file as all added", () => {
    const diff = DiffLines.buildToolDiff(
      "/tmp/new.ts",
      { lines: [], hasTrailingNewline: false },
      { lines: ["one", "two", "three"], hasTrailingNewline: true },
      0
    );
    expect(DiffView.countStats(diff)).toEqual({ added: 3, removed: 0 });
  });

  test("counts a fully emptied file as all removed", () => {
    const diff = DiffLines.buildToolDiff(
      "/tmp/old.ts",
      { lines: ["one", "two"], hasTrailingNewline: true },
      { lines: [], hasTrailingNewline: false },
      0
    );
    expect(DiffView.countStats(diff)).toEqual({ added: 0, removed: 2 });
  });

  test("ignores context lines", () => {
    const diff = DiffLines.buildToolDiff(
      "/tmp/ctx.ts",
      { lines: ["a", "b", "c"], hasTrailingNewline: true },
      { lines: ["a", "B", "c"], hasTrailingNewline: true },
      3
    );
    expect(DiffView.countStats(diff)).toEqual({ added: 1, removed: 1 });
  });
});
