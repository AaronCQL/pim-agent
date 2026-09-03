import {
  getLanguageFromPath,
  highlightCode,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type {
  IntraLineRange,
  ToolDiff,
  ToolDiffHunk,
  ToolDiffLine,
} from "./DiffLines";

export type DiffRenderOptions = {
  readonly toolDiff: ToolDiff;
  readonly theme: Theme;
};

export type DiffHighlighter = (block: string) => readonly string[];

type DiffBackgrounds = {
  readonly added: string;
  readonly removed: string;
  readonly addedEmph: string;
  readonly removedEmph: string;
};

const TAB = "   ";
const DARK_BG: DiffBackgrounds = {
  added: "\x1b[48;2;13;40;24m",
  removed: "\x1b[48;2;58;20;20m",
  addedEmph: "\x1b[48;2;26;81;47m",
  removedEmph: "\x1b[48;2;100;35;35m",
};
const LIGHT_BG: DiffBackgrounds = {
  added: "\x1b[48;2;218;251;225m",
  removed: "\x1b[48;2;255;235;233m",
  addedEmph: "\x1b[48;2;172;238;187m",
  removedEmph: "\x1b[48;2;255;195;188m",
};
const CLEAR_TO_EOL = "\x1b[K";
const BG_RESET = "\x1b[49m";

function render(options: DiffRenderOptions): string {
  const { toolDiff, theme } = options;

  if (toolDiff.hunks.length === 0) {
    return "";
  }

  const lang = getLanguageFromPath(toolDiff.path);
  const highlighter = makeHighlighter(lang);
  const numberWidth = computeNumberWidth(toolDiff.hunks);
  const backgrounds = backgroundsFor(theme);
  const blocks: string[] = [];

  for (let index = 0; index < toolDiff.hunks.length; index += 1) {
    const hunk = toolDiff.hunks[index];

    if (hunk === undefined) {
      continue;
    }

    blocks.push(renderHunk(hunk, highlighter, theme, numberWidth, backgrounds));

    if (index < toolDiff.hunks.length - 1) {
      blocks.push(renderHunkSeparator(theme, numberWidth));
    }
  }

  return blocks.join("\n");
}

function highlightHunkLines(
  hunk: ToolDiffHunk,
  highlighter: DiffHighlighter
): readonly string[] {
  const oldIndices: (number | undefined)[] = [];
  const newIndices: (number | undefined)[] = [];
  const oldBlock: string[] = [];
  const newBlock: string[] = [];

  for (const line of hunk.lines) {
    if (line.kind === "added") {
      oldIndices.push(undefined);
      newIndices.push(newBlock.length);
      newBlock.push(line.text);
      continue;
    }

    if (line.kind === "removed") {
      oldIndices.push(oldBlock.length);
      newIndices.push(undefined);
      oldBlock.push(line.text);
      continue;
    }

    oldIndices.push(oldBlock.length);
    newIndices.push(newBlock.length);
    oldBlock.push(line.text);
    newBlock.push(line.text);
  }

  const oldHighlighted =
    oldBlock.length === 0 ? [] : highlighter(oldBlock.join("\n"));
  const newHighlighted =
    newBlock.length === 0 ? [] : highlighter(newBlock.join("\n"));

  return hunk.lines.map((line, idx) => {
    if (line.kind === "removed") {
      const blockIdx = oldIndices[idx];
      return blockIdx === undefined
        ? line.text
        : (oldHighlighted[blockIdx] ?? line.text);
    }

    const blockIdx = newIndices[idx];
    return blockIdx === undefined
      ? line.text
      : (newHighlighted[blockIdx] ?? line.text);
  });
}

function makeHighlighter(lang: string | undefined): DiffHighlighter {
  if (lang === undefined) {
    return (block) => detab(block).split("\n");
  }

  return (block) => highlightCode(detab(block), lang);
}

function detab(text: string): string {
  return text.replace(/\t/g, TAB);
}

function backgroundsFor(theme: Theme): DiffBackgrounds {
  return isLightTheme(theme) ? LIGHT_BG : DARK_BG;
}

function isLightTheme(theme: Theme): boolean {
  const name = theme.name?.toLowerCase() ?? "";
  return name === "light" || name.includes("light");
}

function computeNumberWidth(hunks: readonly ToolDiffHunk[]): number {
  let max = 0;

  for (const hunk of hunks) {
    max = Math.max(max, hunk.oldStart + hunk.oldLines - 1);
    max = Math.max(max, hunk.newStart + hunk.newLines - 1);
  }

  return Math.max(1, String(max).length);
}

function renderHunk(
  hunk: ToolDiffHunk,
  highlighter: DiffHighlighter,
  theme: Theme,
  numberWidth: number,
  backgrounds: DiffBackgrounds
): string {
  const highlightedLines = highlightHunkLines(hunk, highlighter);
  const rendered: string[] = [];

  for (let i = 0; i < hunk.lines.length; i += 1) {
    const line = hunk.lines[i];
    const content = highlightedLines[i];

    if (line === undefined || content === undefined) {
      continue;
    }

    rendered.push(renderLine(line, content, theme, numberWidth, backgrounds));
  }

  return rendered.join("\n");
}

function renderLine(
  line: ToolDiffLine,
  content: string,
  theme: Theme,
  numberWidth: number,
  backgrounds: DiffBackgrounds
): string {
  const prefix = formatPrefix(line, theme, numberWidth);
  const emphasized = applyLineEmphasis(line, content, backgrounds);
  return applyBackground(line.kind, ` ${prefix}${emphasized}`, backgrounds);
}

function applyLineEmphasis(
  line: ToolDiffLine,
  content: string,
  backgrounds: DiffBackgrounds
): string {
  const ranges = line.emphasis;

  if (ranges === undefined || ranges.length === 0) {
    return content;
  }

  if (line.kind === "added") {
    return applyEmphasis(
      content,
      ranges,
      backgrounds.added,
      backgrounds.addedEmph
    );
  }

  if (line.kind === "removed") {
    return applyEmphasis(
      content,
      ranges,
      backgrounds.removed,
      backgrounds.removedEmph
    );
  }

  return content;
}

function applyEmphasis(
  text: string,
  ranges: readonly IntraLineRange[],
  lineBg: string,
  emphBg: string
): string {
  if (ranges.length === 0) {
    return text;
  }

  const starts = new Set<number>();
  const ends = new Set<number>();

  for (const range of ranges) {
    if (range.end > range.start) {
      starts.add(range.start);
      ends.add(range.end);
    }
  }

  if (starts.size === 0) {
    return text;
  }

  let result = "";
  let visiblePos = 0;
  let i = 0;
  let segStart = 0;

  while (i < text.length) {
    if (text.charCodeAt(i) === 0x1b && text[i + 1] === "[") {
      const escEnd = text.indexOf("m", i + 2);

      if (escEnd === -1) {
        return result + text.slice(segStart);
      }

      i = escEnd + 1;
      continue;
    }

    if (ends.has(visiblePos) || starts.has(visiblePos)) {
      if (i > segStart) {
        result += text.slice(segStart, i);
      }
      if (ends.has(visiblePos)) {
        result += lineBg;
      }
      if (starts.has(visiblePos)) {
        result += emphBg;
      }
      segStart = i;
    }

    visiblePos += 1;
    i += 1;
  }

  if (i > segStart) {
    result += text.slice(segStart, i);
  }
  if (ends.has(visiblePos)) {
    result += lineBg;
  }
  if (starts.has(visiblePos)) {
    result += emphBg;
  }

  return result;
}

function applyBackground(
  kind: ToolDiffLine["kind"],
  text: string,
  backgrounds: DiffBackgrounds
): string {
  if (kind === "added") {
    return `${backgrounds.added}${text}${CLEAR_TO_EOL}${BG_RESET}`;
  }

  if (kind === "removed") {
    return `${backgrounds.removed}${text}${CLEAR_TO_EOL}${BG_RESET}`;
  }

  return text;
}

function formatPrefix(
  line: ToolDiffLine,
  theme: Theme,
  numberWidth: number
): string {
  const numLabel = formatLineNumber(relevantLineNumber(line), numberWidth);
  const sign = signFor(line.kind);
  const gutter = `${numLabel} ${sign} `;

  if (line.kind === "added") {
    return theme.fg("toolDiffAdded", gutter);
  }

  if (line.kind === "removed") {
    return theme.fg("toolDiffRemoved", gutter);
  }

  return theme.fg("toolDiffContext", gutter);
}

function relevantLineNumber(line: ToolDiffLine): number | undefined {
  if (line.kind === "added") {
    return line.newLine;
  }

  if (line.kind === "removed") {
    return line.oldLine;
  }

  return line.newLine ?? line.oldLine;
}

function signFor(kind: ToolDiffLine["kind"]): string {
  if (kind === "added") {
    return "+";
  }

  if (kind === "removed") {
    return "−";
  }

  return " ";
}

function formatLineNumber(value: number | undefined, width: number): string {
  if (value === undefined) {
    return " ".repeat(width);
  }

  return String(value).padStart(width, " ");
}

function renderHunkSeparator(theme: Theme, numberWidth: number): string {
  const filler = " ".repeat(numberWidth);
  return theme.fg("toolDiffContext", ` ${filler}   ⋯`);
}

export const DiffRenderer = {
  render,
  highlightHunkLines,
  applyEmphasis,
};
