import type { ToolDiffHunk, ToolDiffLine } from "../shared/DiffLines";
import type { LineSpan } from "../shared/RepoDiff";

/** Unchanged lines no hunk shows, in new-side numbers. `above`/`below`: that end touches a hunk. */
export type DiffGap = {
  readonly start: number;
  readonly end: number;
  readonly count: number;
  readonly above: boolean;
  readonly below: boolean;
};

/** Hunks and gaps in display order. */
export type DiffPart =
  | { readonly hunk: ToolDiffHunk }
  | { readonly gap: DiffGap };

/** Lines one click reveals at each end of a gap. */
const STEP = 25;

/** A smaller remainder is revealed with the click instead of left as its own gap. */
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

/** Gaps before, between and (given `total` lines) after the hunks. */
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

/** Line spans to fetch when a gap is opened: `STEP` lines at each hunk-facing end, or the whole gap if little would remain. */
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

/** Lines that opening `gap` would reveal. */
function revealed(gap: DiffGap): number {
  return spans(gap).reduce(
    (total, span) => total + span.end - span.start + 1,
    0
  );
}

function parts(
  hunks: readonly ToolDiffHunk[],
  total?: number
): readonly DiffPart[] {
  const found = gaps(hunks, total);
  const tail = found.find((gap) => !gap.below);
  // Keyed by end line, i.e. the line before the hunk it leads into.
  const leading = new Map(found.map((gap) => [gap.end, gap]));
  return [
    ...hunks.flatMap((hunk) => {
      const gap = leading.get(hunk.newStart - 1);
      return gap === undefined ? [{ hunk }] : [{ gap }, { hunk }];
    }),
    ...(tail === undefined ? [] : [{ gap: tail }]),
  ];
}

type Run = {
  readonly oldStart: number;
  readonly newStart: number;
  readonly lines: ToolDiffLine[];
  /** New-side line count. */
  newCount: number;
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
    newLines: run.newCount,
    lines: run.lines,
  };
}

/**
 * Splices `known` lines (by new-side number) into the hunks as context and
 * merges hunks that now touch. Only lines contiguous with a hunk edge are used.
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
    return last === undefined ? 0 : last.newStart + last.newCount - 1;
  };

  const add = (run: Run): void => {
    const last = runs.at(-1);
    if (last !== undefined && reached() + 1 === run.newStart) {
      last.lines.push(...run.lines);
      last.newCount += run.newCount;
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
      before.push(context(line, hunk.oldStart - hunk.newStart, text));
    }
    before.reverse();
    const lines = [...before, ...hunk.lines];
    add({
      oldStart: hunk.oldStart - before.length,
      newStart: hunk.newStart - before.length,
      lines,
      newCount: before.length + newLinesOf(hunk.lines),
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
        newCount: after.length,
      });
    }
  }

  return runs.map(hunkOf);
}

export const DiffExpand = { gaps, parts, spans, revealed, expand };
