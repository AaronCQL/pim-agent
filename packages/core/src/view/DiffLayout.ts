import type { ToolDiffHunk } from "../shared/DiffLines";

/**
 * The parts of drawing a diff that every surface has to get right the same
 * way, kept free of pi imports so a browser bundle can have them: the ANSI
 * painter and the web painter both come through here, and neither owns the
 * rules.
 */

/** What a tab is worth. Three columns, as the TUI has always drawn it. */
const TAB = "   ";

function detab(text: string): string {
  return text.replace(/\t/g, TAB);
}

/**
 * One highlighted result per hunk line, produced by highlighting each *side*
 * of the hunk as a whole block rather than line by line.
 *
 * Line-at-a-time highlighting has no way to know it is inside a multi-line
 * string or a block comment, so it restarts at every newline and paints the
 * body of a docblock as code. The old lines therefore rejoin into the file as
 * it was, the new lines into the file as it will be, each is highlighted once,
 * and the results are dealt back out to the lines they came from.
 *
 * Generic over what a highlighter returns: the terminal wants a string of SGR
 * per line, the web wants a list of tokens, and the bookkeeping is the same.
 */
function mapSides<T>(
  hunk: ToolDiffHunk,
  highlight: (block: string) => readonly T[]
): readonly (T | undefined)[] {
  const oldIndices: (number | undefined)[] = [];
  const newIndices: (number | undefined)[] = [];
  const oldBlock: string[] = [];
  const newBlock: string[] = [];

  for (const line of hunk.lines) {
    // A context line belongs to both sides, so it is highlighted twice and
    // read back off the new one: it has to keep its place in each block for
    // the surrounding lines to tokenise in the right state.
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

/**
 * Columns the widest line number needs, so every gutter in one diff is the
 * same width and the code starts in one column across all of its hunks.
 */
function gutterWidth(hunks: readonly ToolDiffHunk[]): number {
  let max = 0;

  for (const hunk of hunks) {
    max = Math.max(max, hunk.oldStart + hunk.oldLines - 1);
    max = Math.max(max, hunk.newStart + hunk.newLines - 1);
  }

  return Math.max(1, String(max).length);
}

/** The number a line is known by: its own side's, and the new side for context. */
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
