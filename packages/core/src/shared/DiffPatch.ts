import * as Diff from "diff";
import {
  DiffLines,
  type ToolDiff,
  type ToolDiffHunk,
  type ToolDiffLine,
  type ToolDiffLineKind,
} from "./DiffLines";

function fromUnified(path: string, patch: string): ToolDiff | undefined {
  const hunks = Diff.parsePatch(patch)
    .flatMap((file) => file.hunks)
    .map(toHunk)
    .filter((hunk) => hunk.lines.length > 0);

  return hunks.length === 0 ? undefined : { path, hunks };
}

function toHunk(hunk: Diff.StructuredPatchHunk): ToolDiffHunk {
  const lines: ToolDiffLine[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;

  for (const raw of hunk.lines) {
    if (raw.startsWith("\\")) {
      continue;
    }

    const kind = kindOf(raw);
    const text = raw.slice(1);

    if (kind === "added") {
      lines.push({ kind, newLine, text });
      newLine += 1;
      continue;
    }

    if (kind === "removed") {
      lines.push({ kind, oldLine, text });
      oldLine += 1;
      continue;
    }

    lines.push({ kind, oldLine, newLine, text });
    oldLine += 1;
    newLine += 1;
  }

  return {
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: DiffLines.attachEmphasis(lines),
  };
}

function kindOf(line: string): ToolDiffLineKind {
  if (line.startsWith("+")) {
    return "added";
  }

  if (line.startsWith("-")) {
    return "removed";
  }

  return "context";
}

export const DiffPatch = { fromUnified };
