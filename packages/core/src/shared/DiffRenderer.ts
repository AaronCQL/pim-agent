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

const KINDS = {
  context: { sign: " ", role: "toolDiffContext" },
  added: {
    sign: "+",
    role: "toolDiffAdded",
    bg: "added",
    emph: "addedEmph",
  },
  removed: {
    sign: "−",
    role: "toolDiffRemoved",
    bg: "removed",
    emph: "removedEmph",
  },
} as const satisfies Record<
  ToolDiffLine["kind"],
  {
    readonly sign: string;
    readonly role: string;
    readonly bg?: keyof DiffBackgrounds;
    readonly emph?: keyof DiffBackgrounds;
  }
>;

function renderLines(options: DiffRenderOptions): string[] {
  const { toolDiff, theme } = options;

  if (toolDiff.hunks.length === 0) {
    return [];
  }

  const highlighter = makeHighlighter(Languages.fromPath(toolDiff.path));
  const numberWidth = DiffLayout.gutterWidth(toolDiff.hunks);
  const backgrounds = backgroundsFor(theme);
  const separator = renderHunkSeparator(theme, numberWidth);
  const lines: string[] = [];

  for (const [index, hunk] of toolDiff.hunks.entries()) {
    if (index > 0) {
      lines.push(separator);
    }

    lines.push(
      ...renderHunk(hunk, highlighter, theme, numberWidth, backgrounds)
    );
  }

  return lines;
}

function render(options: DiffRenderOptions): string {
  return renderLines(options).join("\n");
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
): readonly string[] {
  const highlightedLines = highlightHunkLines(hunk, highlighter);

  return hunk.lines.map((line, i) =>
    renderLine(
      line,
      highlightedLines[i] ?? line.text,
      theme,
      numberWidth,
      backgrounds
    )
  );
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
  const kind = KINDS[line.kind];

  if (ranges === undefined || ranges.length === 0 || !("emph" in kind)) {
    return content;
  }

  return applyEmphasis(
    content,
    ranges,
    backgrounds[kind.bg],
    backgrounds[kind.emph]
  );
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
  const spec = KINDS[kind];

  return "bg" in spec
    ? `${backgrounds[spec.bg]}${text}${CLEAR_TO_EOL}${BG_RESET}`
    : text;
}

function formatPrefix(
  line: ToolDiffLine,
  theme: Theme,
  numberWidth: number
): string {
  const numLabel = formatLineNumber(DiffLayout.lineNumber(line), numberWidth);
  const kind = KINDS[line.kind];

  return theme.fg(kind.role, `${numLabel} ${kind.sign} `);
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
  renderLines,
  highlightHunkLines,
  applyEmphasis,
};
