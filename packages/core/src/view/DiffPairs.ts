import type { ToolDiffHunk, ToolDiffLine } from "../shared/DiffLines";

/** One row of a split view: the old side, the new side, or both. */
export type DiffPair = {
  readonly left?: ToolDiffLine;
  readonly right?: ToolDiffLine;
};

function pair(hunk: ToolDiffHunk): readonly DiffPair[] {
  const pairs: DiffPair[] = [];
  let removed: ToolDiffLine[] = [];
  let added: ToolDiffLine[] = [];

  const zip = (): void => {
    const rows = Math.max(removed.length, added.length);
    for (let index = 0; index < rows; index += 1) {
      pairs.push({ left: removed[index], right: added[index] });
    }
    removed = [];
    added = [];
  };

  for (const line of hunk.lines) {
    if (line.kind === "context") {
      zip();
      pairs.push({ left: line, right: line });
      continue;
    }

    if (line.kind === "added") {
      added.push(line);
      continue;
    }

    // A removal after an addition starts a new replacement rather than joining the last.
    if (added.length > 0) {
      zip();
    }
    removed.push(line);
  }

  zip();

  return pairs;
}

export const DiffPairs = { pair };
