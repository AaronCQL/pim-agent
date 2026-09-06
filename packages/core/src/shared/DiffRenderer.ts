import { highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { DiffLayout } from "../view/DiffLayout";
import type {
  IntraLineRange,
  ToolDiff,
  ToolDiffHunk,
  ToolDiffLine,
} from "./DiffLines";
import { Languages } from "./Languages";

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

  const lang = Languages.fromPath(toolDiff.path);
  const highlighter = makeHighlighter(lang);
  const numberWidth = DiffLayout.gutterWidth(toolDiff.hunks);
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
  const highlighted = DiffLayout.mapSides(hunk, highlighter);
  return hunk.lines.map((line, index) => highlighted[index] ?? line.text);
}

function makeHighlighter(lang: string | undefined): DiffHighlighter {
  if (lang === undefined) {
    return (block) => DiffLayout.detab(block).split("\n");
  }

  return (block) => highlightCode(DiffLayout.detab(block), lang);
}

function backgroundsFor(theme: Theme): DiffBackgrounds {
  return isLightTheme(theme) ? LIGHT_BG : DARK_BG;
}

function isLightTheme(theme: Theme): boolean {
  const name = theme.name?.toLowerCase() ?? "";
  return name === "light" || name.includes("light");
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
  const numLabel = formatLineNumber(DiffLayout.lineNumber(line), numberWidth);
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
