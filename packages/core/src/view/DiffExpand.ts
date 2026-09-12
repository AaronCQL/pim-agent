import type { ToolDiffHunk, ToolDiffLine } from "../shared/DiffLines";
import type { LineSpan } from "../shared/RepoDiff";

/**
 * A stretch of a file neither side changed and no hunk shows, numbered on the
 * new side. `above` and `below` say which ends of it sit against a hunk, which
 * is where a reader asking for more of it is given it.
 */
export type DiffGap = {
  readonly start: number;
  readonly end: number;
  readonly count: number;
  readonly above: boolean;
  readonly below: boolean;
};

/** What a diff is painted from, top to bottom: hunks and the gaps between them. */
export type DiffPart =
  | { readonly hunk: ToolDiffHunk }
  | { readonly gap: DiffGap };

/** Lines one click reveals at each end of a gap. */
const STEP = 25;

/** A remainder this small is taken with the click rather than left as a row of its own. */
const MIN_REMAINDER = 10;

function newEnd(hunk: ToolDiffHunk): number {
  return hunk.newStart + hunk.newLines - 1;
}

function oldEnd(hunk: ToolDiffHunk): number {
  return hunk.oldStart + hunk.oldLines - 1;
}

function gapOf(
  start: number,
  end: number,
  above: boolean,
  below: boolean
): readonly DiffGap[] {
  return end < start
    ? []
    : [{ start, end, count: end - start + 1, above, below }];
}

/**
 * Every gap in one file's hunks: before the first, between each pair, and
 * after the last once `total` says where the file ends. A file with no new
 * side to number has none of them.
 */
function gaps(
  hunks: readonly ToolDiffHunk[],
  total?: number
): readonly DiffGap[] {
  const first = hunks[0];
  const last = hunks.at(-1);
  if (first === undefined || last === undefined) {
    return [];
  }

  return [
    ...gapOf(1, first.newStart - 1, false, true),
    ...hunks.flatMap((hunk, index) => {
      const next = hunks[index + 1];
      return next === undefined
        ? []
        : gapOf(newEnd(hunk) + 1, next.newStart - 1, true, true);
    }),
    ...(total === undefined ? [] : gapOf(newEnd(last) + 1, total, true, false)),
  ];
}

/**
 * What to ask the server for when a reader opens a gap: a step against each
 * hunk it touches, or the whole gap when what would be left of it is a sliver.
 */
function spans(gap: DiffGap): readonly LineSpan[] {
  const edges = (gap.above ? 1 : 0) + (gap.below ? 1 : 0);
  if (gap.count <= edges * STEP + MIN_REMAINDER) {
    return [{ start: gap.start, end: gap.end }];
  }
  return [
    ...(gap.above ? [{ start: gap.start, end: gap.start + STEP - 1 }] : []),
    ...(gap.below ? [{ start: gap.end - STEP + 1, end: gap.end }] : []),
  ];
}

/** How many lines opening a gap would put on the page. */
function revealed(gap: DiffGap): number {
  return spans(gap).reduce(
    (total, span) => total + span.end - span.start + 1,
    0
  );
}

/** The hunks with each gap in its place among them. */
function parts(
  hunks: readonly ToolDiffHunk[],
  total?: number
): readonly DiffPart[] {
  const found = gaps(hunks, total);
  const tail = found.find((gap) => !gap.below);
  return [
    ...hunks.flatMap((hunk) => {
      const gap = found.find(
        (candidate) => candidate.end === hunk.newStart - 1
      );
      return gap === undefined ? [{ hunk }] : [{ gap }, { hunk }];
    }),
    ...(tail === undefined ? [] : [{ gap: tail }]),
  ];
}

type Run = {
  readonly oldStart: number;
  readonly newStart: number;
  readonly lines: ToolDiffLine[];
};

function context(line: number, offset: number, text: string): ToolDiffLine {
  return { kind: "context", oldLine: line + offset, newLine: line, text };
}

function newLinesOf(lines: readonly ToolDiffLine[]): number {
  return lines.filter((line) => line.kind !== "removed").length;
}

function hunkOf(run: Run): ToolDiffHunk {
  return {
    oldStart: run.oldStart,
    newStart: run.newStart,
    oldLines: run.lines.filter((line) => line.kind !== "added").length,
    newLines: newLinesOf(run.lines),
    lines: run.lines,
  };
}

/**
 * The hunks with every line a reader has since been given spliced back into
 * the gaps around them, and hunks that now touch merged into one. Only lines
 * running from a hunk's own edge are taken: an island in the middle of a gap
 * is not a thing this ever asks for.
 */
function expand(
  hunks: readonly ToolDiffHunk[],
  known: ReadonlyMap<number, string>
): readonly ToolDiffHunk[] {
  if (known.size === 0) {
    return hunks;
  }

  const runs: Run[] = [];

  const reached = (): number => {
    const last = runs.at(-1);
    return last === undefined ? 0 : last.newStart + newLinesOf(last.lines) - 1;
  };

  const add = (run: Run): void => {
    const last = runs.at(-1);
    if (last !== undefined && reached() + 1 === run.newStart) {
      last.lines.push(...run.lines);
      return;
    }
    runs.push(run);
  };

  for (const [index, hunk] of hunks.entries()) {
    const before: ToolDiffLine[] = [];
    const floor = reached();
    for (let line = hunk.newStart - 1; line > floor; line -= 1) {
      const text = known.get(line);
      if (text === undefined) {
        break;
      }
      before.unshift(context(line, hunk.oldStart - hunk.newStart, text));
    }
    add({
      oldStart: hunk.oldStart - before.length,
      newStart: hunk.newStart - before.length,
      lines: [...before, ...hunk.lines],
    });

    const after: ToolDiffLine[] = [];
    const ceiling = hunks[index + 1]?.newStart ?? Infinity;
    for (let line = newEnd(hunk) + 1; line < ceiling; line += 1) {
      const text = known.get(line);
      if (text === undefined) {
        break;
      }
      after.push(context(line, oldEnd(hunk) - newEnd(hunk), text));
    }
    if (after.length > 0) {
      add({
        oldStart: oldEnd(hunk) + 1,
        newStart: newEnd(hunk) + 1,
        lines: after,
      });
    }
  }

  return runs.map(hunkOf);
}

export const DiffExpand = { gaps, parts, spans, revealed, expand, STEP };
