import { describe, expect, test } from "bun:test";

import type { ToolDiffHunk, ToolDiffLine } from "../shared/DiffLines";
import { DiffPairs } from "./DiffPairs";

/** `a` context, `+a` added, `-a` removed — one hunk written the way a patch reads. */
function hunk(...spec: readonly string[]): ToolDiffHunk {
  let oldLine = 1;
  let newLine = 1;
  const lines = spec.map<ToolDiffLine>((entry) => {
    const text = entry.slice(1);
    if (entry.startsWith("+")) {
      return { kind: "added", newLine: newLine++, text };
    }
    if (entry.startsWith("-")) {
      return { kind: "removed", oldLine: oldLine++, text };
    }
    return {
      kind: "context",
      oldLine: oldLine++,
      newLine: newLine++,
      text: entry,
    };
  });

  return {
    oldStart: 1,
    oldLines: oldLine - 1,
    newStart: 1,
    newLines: newLine - 1,
    lines,
  };
}

/** `old|new`, a missing side written as a dash, which is how the grid reads. */
function rows(source: ToolDiffHunk): readonly string[] {
  return DiffPairs.pair(source).map(
    (row) => `${row.left?.text ?? "-"}|${row.right?.text ?? "-"}`
  );
}

describe("DiffPairs.pair", () => {
  test("a context line holds both sides", () => {
    expect(rows(hunk("one", "two"))).toEqual(["one|one", "two|two"]);
  });

  test("an even replacement zips line for line", () => {
    expect(rows(hunk("keep", "-a", "-b", "+A", "+B", "tail"))).toEqual([
      "keep|keep",
      "a|A",
      "b|B",
      "tail|tail",
    ]);
  });

  test("more added than removed pads the old side", () => {
    expect(rows(hunk("-a", "+A", "+B", "+C"))).toEqual(["a|A", "-|B", "-|C"]);
  });

  test("more removed than added pads the new side", () => {
    expect(rows(hunk("-a", "-b", "-c", "+A"))).toEqual(["a|A", "b|-", "c|-"]);
  });

  test("an added-only run takes the new side alone", () => {
    expect(rows(hunk("keep", "+A", "+B"))).toEqual(["keep|keep", "-|A", "-|B"]);
  });

  test("a removed-only run takes the old side alone", () => {
    expect(rows(hunk("-a", "-b", "keep"))).toEqual(["a|-", "b|-", "keep|keep"]);
  });

  test("an empty hunk pairs nothing", () => {
    expect(DiffPairs.pair(hunk())).toEqual([]);
  });

  test("a context line between two runs separates them", () => {
    expect(rows(hunk("-a", "+A", "keep", "-b", "+B"))).toEqual([
      "a|A",
      "keep|keep",
      "b|B",
    ]);
  });

  test("a removal after an addition starts a new replacement", () => {
    expect(rows(hunk("+A", "-a", "+B"))).toEqual(["-|A", "a|B"]);
  });

  test("both sides of a pair are the hunk's own lines", () => {
    const source = hunk("keep", "-a", "+A");
    const pairs = DiffPairs.pair(source);

    expect(pairs[0]?.left).toBe(source.lines[0]);
    expect(pairs[0]?.right).toBe(source.lines[0]);
    expect(pairs[1]?.left).toBe(source.lines[1]);
    expect(pairs[1]?.right).toBe(source.lines[2]);
  });
});
