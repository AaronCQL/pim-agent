import { describe, expect, test } from "bun:test";
import { DiffLines } from "./DiffLines";
import { DiffView } from "./DiffView";

describe("DiffView.countStats", () => {
  test("returns zeros when diff is undefined", () => {
    expect(DiffView.countStats(undefined)).toEqual({ added: 0, removed: 0 });
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
});
