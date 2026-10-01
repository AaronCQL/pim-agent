import { describe, expect, test } from "bun:test";

import type { ToolDiffHunk, ToolDiffLine } from "../shared/DiffLines";
import { DiffPairs } from "./DiffPairs";

/** `a` context, `+a` added, `-a` removed. */
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

/** `old|new`, with `-` for a missing side. */
function rows(source: ToolDiffHunk): readonly string[] {
  return DiffPairs.pair(source).map(
    (row) => `${row.left?.text ?? "-"}|${row.right?.text ?? "-"}`
  );
}

describe("DiffPairs.pair", () => {
  test.each([
    ["context holds both sides", ["one", "two"], ["one|one", "two|two"]],
    [
      "an even replacement zips line for line",
      ["keep", "-a", "-b", "+A", "+B", "tail"],
      ["keep|keep", "a|A", "b|B", "tail|tail"],
    ],
    [
      "more added than removed pads the old side",
      ["-a", "+A", "+B", "+C"],
      ["a|A", "-|B", "-|C"],
    ],
    [
      "more removed than added pads the new side",
      ["-a", "-b", "-c", "+A"],
      ["a|A", "b|-", "c|-"],
    ],
    [
      "a context line separates two runs",
      ["-a", "+A", "keep", "-b", "+B"],
      ["a|A", "keep|keep", "b|B"],
    ],
    [
      "a removal after an addition starts a new replacement",
      ["+A", "-a", "+B"],
      ["-|A", "a|B"],
    ],
  ])("%s", (_name, spec, expected) => {
    expect(rows(hunk(...spec))).toEqual(expected);
  });

  test("an empty hunk pairs nothing", () => {
    expect(DiffPairs.pair(hunk())).toEqual([]);
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
