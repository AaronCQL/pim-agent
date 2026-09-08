import type { ToolDiffHunk } from "../shared/DiffLines";

const TAB = "   ";

function detab(text: string): string {
  return text.replace(/\t/g, TAB);
}

// Highlight each side as one block, never line by line, or multi-line strings and comments mis-tokenise.
function mapSides<T>(
  hunk: ToolDiffHunk,
  highlight: (block: string) => readonly T[]
): readonly (T | undefined)[] {
  const oldIndices: (number | undefined)[] = [];
  const newIndices: (number | undefined)[] = [];
  const oldBlock: string[] = [];
  const newBlock: string[] = [];

  for (const line of hunk.lines) {
    // A context line must hold a slot in both blocks to keep tokeniser state aligned.
    if (line.kind !== "added") {
      oldIndices.push(oldBlock.length);
      oldBlock.push(line.text);
    } else {
      oldIndices.push(undefined);
    }

    if (line.kind !== "removed") {
      newIndices.push(newBlock.length);
      newBlock.push(line.text);
    } else {
      newIndices.push(undefined);
    }
  }

  const oldLines = oldBlock.length === 0 ? [] : highlight(oldBlock.join("\n"));
  const newLines = newBlock.length === 0 ? [] : highlight(newBlock.join("\n"));

  return hunk.lines.map((line, index) => {
    const side = line.kind === "removed" ? oldLines : newLines;
    const at = line.kind === "removed" ? oldIndices[index] : newIndices[index];
    return at === undefined ? undefined : side[at];
  });
}

function gutterWidth(hunks: readonly ToolDiffHunk[]): number {
  let max = 0;

  for (const hunk of hunks) {
    max = Math.max(max, hunk.oldStart + hunk.oldLines - 1);
    max = Math.max(max, hunk.newStart + hunk.newLines - 1);
  }

  return Math.max(1, String(max).length);
}

function lineNumber(line: ToolDiffHunk["lines"][number]): number | undefined {
  if (line.kind === "added") {
    return line.newLine;
  }

  if (line.kind === "removed") {
    return line.oldLine;
  }

  return line.newLine ?? line.oldLine;
}

export const DiffLayout = { detab, mapSides, gutterWidth, lineNumber };
