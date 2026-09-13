import { expect, test } from "bun:test";

import { DiffLines, type ToolDiffHunk } from "../shared/DiffLines";
import { DiffExpand, type DiffGap } from "./DiffExpand";

const PATH = "src/alpha.ts";

/** A file of `count` numbered lines, so every line says which one it is. */
function file(count: number): string {
  return `${Array.from({ length: count }, (_, at) => `line ${at + 1}`).join("\n")}\n`;
}

function edited(count: number, at: readonly number[]): string {
  const lines = file(count).split("\n");
  for (const line of at) {
    lines[line - 1] = `LINE ${line}`;
  }
  return lines.join("\n");
}

function hunksOf(from: string, to: string): readonly ToolDiffHunk[] {
  return (
    DiffLines.buildToolDiff(
      PATH,
      DiffLines.fromText(from),
      DiffLines.fromText(to),
      3
    )?.hunks ?? []
  );
}

/** Two hunks in a 200-line file: one at the top, one near the bottom. */
function twoHunks(): readonly ToolDiffHunk[] {
  return hunksOf(file(200), edited(200, [10, 150]));
}

function known(lines: readonly number[]): ReadonlyMap<number, string> {
  return new Map(lines.map((line) => [line, `line ${line}`]));
}

test("a gap is every line between two hunks, and either end of the file", () => {
  const gaps = DiffExpand.gaps(twoHunks(), 200);

  expect(gaps).toEqual([
    { start: 1, end: 6, count: 6, above: false, below: true },
    { start: 14, end: 146, count: 133, above: true, below: true },
    { start: 154, end: 200, count: 47, above: true, below: false },
  ]);
});

test("without a total there is no tail gap to open", () => {
  expect(DiffExpand.gaps(twoHunks()).map((gap) => gap.start)).toEqual([1, 14]);
});

test("a file shown whole has no gaps at all", () => {
  expect(DiffExpand.gaps(hunksOf(file(5), edited(5, [3])), 5)).toEqual([]);
});

test("hunks are interleaved with the gaps around them", () => {
  const hunks = twoHunks();
  const parts = DiffExpand.parts(hunks, 200);

  expect(parts.map((part) => ("gap" in part ? "gap" : "hunk"))).toEqual([
    "gap",
    "hunk",
    "gap",
    "hunk",
    "gap",
  ]);
  expect(parts[1]).toEqual({ hunk: hunks[0] as ToolDiffHunk });
});

const gap = (count: number, above: boolean, below: boolean): DiffGap => ({
  start: 10,
  end: 9 + count,
  count,
  above,
  below,
});

test("a wide gap opens by a step against each hunk it touches", () => {
  expect(DiffExpand.spans(gap(200, true, true))).toEqual([
    { start: 10, end: 34 },
    { start: 185, end: 209 },
  ]);
  expect(DiffExpand.revealed(gap(200, true, true))).toBe(50);
});

test("an end of the file opens in the one direction it has", () => {
  expect(DiffExpand.spans(gap(200, false, true))).toEqual([
    { start: 185, end: 209 },
  ]);
  expect(DiffExpand.spans(gap(200, true, false))).toEqual([
    { start: 10, end: 34 },
  ]);
});

test("a gap that a step would leave a sliver of is taken whole", () => {
  expect(DiffExpand.spans(gap(60, true, true))).toEqual([
    { start: 10, end: 69 },
  ]);
  expect(DiffExpand.spans(gap(34, false, true))).toEqual([
    { start: 10, end: 43 },
  ]);
  expect(DiffExpand.spans(gap(61, true, true))).toHaveLength(2);
});

test("lines a reader was given join the hunk they run from, numbered on both sides", () => {
  const hunks = twoHunks();
  const [first] = DiffExpand.expand(hunks, known([14, 15, 16]));

  expect(first?.newStart).toBe(7);
  expect(first?.newLines).toBe(10);
  expect(first?.lines.at(-1)).toEqual({
    kind: "context",
    oldLine: 16,
    newLine: 16,
    text: "line 16",
  });
});

test("a deletion offsets the old side of what is spliced in", () => {
  const shortened = edited(200, [150])
    .split("\n")
    .filter((_, at) => at !== 9)
    .join("\n");
  const hunks = hunksOf(file(200), shortened);
  const line = DiffExpand.expand(hunks, known([13]))[0]?.lines.at(-1);

  expect(line?.newLine).toBe(13);
  expect(line?.oldLine).toBe(14);
});

test("a gap opened to the end closes, and the hunks either side become one", () => {
  const hunks = twoHunks();
  const whole = Array.from({ length: 133 }, (_, at) => 14 + at);
  const opened = DiffExpand.expand(hunks, known(whole));

  expect(opened).toHaveLength(1);
  expect(opened[0]?.newStart).toBe(7);
  expect(opened[0]?.newLines).toBe(147);
  expect(DiffExpand.gaps(opened, 200).map((found) => found.count)).toEqual([
    6, 47,
  ]);
});

test("lines adrift in the middle of a gap are left where they are", () => {
  const hunks = twoHunks();

  expect(DiffExpand.expand(hunks, known([80, 81]))).toEqual(hunks);
});

test("the head of a file joins the first hunk", () => {
  const hunks = twoHunks();
  const opened = DiffExpand.expand(hunks, known([1, 2, 3, 4, 5, 6]));

  expect(opened[0]?.newStart).toBe(1);
  expect(opened[0]?.oldStart).toBe(1);
  expect(DiffExpand.gaps(opened, 200)[0]?.start).toBe(14);
});
