import { basename } from "node:path";
import type {
  DiffHunk,
  NoticeSeverity,
  Span,
  Tone,
  ToolIcon,
  ToolView,
  ViewBlock,
} from "./ViewBlock";

type BlockOf<TKind extends ViewBlock["kind"]> = Extract<
  ViewBlock,
  { kind: TKind }
>;

/**
 * `inline` is the one-line mode a title or a status row uses: multi-line text
 * collapses to its first line, long text is capped, and a path shrinks to its
 * basename. `block` keeps everything.
 */
type Mode = "inline" | "block";

type Painter<TKind extends ViewBlock["kind"]> = (
  block: BlockOf<TKind>,
  mode: Mode
) => readonly string[];

type PainterMap = { readonly [TKind in ViewBlock["kind"]]: Painter<TKind> };

/**
 * How a block sits in a body. `flow` is ordinary lines, `embed` is a
 * preformatted payload that must not be re-wrapped, `heading` steps out of the
 * flow to introduce a sub-item.
 */
export type MarkdownFrame = "flow" | "embed" | "heading";

export type MarkdownGroup = {
  readonly frame: MarkdownFrame;
  readonly lines: readonly string[];
};

/** A tool row: a leading glyph plus the lines that follow it. */
export type PaintedTool = {
  readonly icon: string;
  readonly lines: readonly string[];
};

const INLINE_LIMIT = 180;

/**
 * Paints a `ViewBlock` tree to Telegram-flavoured HTML. Telegram's "markdown"
 * is a small HTML subset (`b`, `i`, `s`, `code`, `pre`, `a`, `blockquote`),
 * which is what this emits; block separation is left to the caller, which
 * joins lines with whatever break its surface uses.
 */
export class MarkdownPainter {
  public static escape(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  public static paint(blocks: readonly ViewBlock[]): string[] {
    return blocks.flatMap((block) => paintBlock(block, "block"));
  }

  /** Flattens blocks to the single line a title or status row occupies. */
  public static paintInline(blocks: readonly ViewBlock[]): string {
    return blocks
      .flatMap((block) => paintBlock(block, "inline"))
      .filter((line) => line !== "")
      .join(" ");
  }

  /** Groups a body by frame so a caller can treat payloads differently. */
  public static paintBody(blocks: readonly ViewBlock[]): MarkdownGroup[] {
    const groups: MarkdownGroup[] = [];
    let open: { frame: MarkdownFrame; lines: string[] } | undefined;

    for (const block of blocks) {
      const frame = FRAMES[block.kind];
      const lines = paintBlock(block, "block");
      if (open?.frame === frame) {
        open.lines.push(...lines);
      } else {
        open = { frame, lines: [...lines] };
        groups.push(open);
      }
    }

    return groups;
  }

  public static icon(icon: ToolIcon | undefined): string {
    return icon === undefined ? DEFAULT_ICON : ICONS[icon];
  }

  /**
   * Paints a whole tool row for a surface with no expand affordance.
   *
   * `title` and `summary` are the always-on parts everywhere else too, so they
   * share the first line. `body` is the expand-only payload and is dropped —
   * it is unbounded (a whole file, a whole diff) and there is nothing to
   * expand it from. Its `section` headings survive: they are the structural
   * outline of a multi-part result (one line per file of a patch), bounded by
   * the number of sub-items rather than by their size.
   */
  public static paintTool(view: ToolView): PaintedTool {
    const head = [view.title, view.summary ?? []]
      .map((blocks) => MarkdownPainter.paintInline(blocks))
      .filter((text) => text !== "")
      .join(" ");
    const outline = MarkdownPainter.paintBody(view.body ?? [])
      .filter((group) => group.frame === "heading")
      .flatMap((group) => group.lines);

    return {
      icon: MarkdownPainter.icon(view.icon),
      lines: [head, ...outline].filter((line) => line !== ""),
    };
  }
}

const ICONS = {
  file: "📄",
  edit: "✏️",
  trash: "🗑️",
  terminal: "⚡️",
  search: "🔎",
  checklist: "📋",
  globe: "🌐",
  upload: "📤",
  clock: "⏰",
  robot: "🤖",
} as const satisfies Record<ToolIcon, string>;

const DEFAULT_ICON = "⚙️";

/**
 * Telegram has no colour, so tones carry no styling: severity that matters is
 * modelled as a `notice`, and emphasis as a span flag. `error` is the one tone
 * that must survive on its own, and bold is the only louder register there is.
 */
const TONE_WRAPPERS = {
  default: identity,
  muted: identity,
  dim: identity,
  error: bold,
  warning: identity,
  accent: identity,
  added: identity,
  removed: identity,
  title: identity,
} as const satisfies Record<Tone, (text: string) => string>;

const NOTICE_PREFIXES = {
  info: "",
  warn: "⚠️ ",
  error: "❌ ",
} as const satisfies Record<NoticeSeverity, string>;

function identity(text: string): string {
  return text;
}

function bold(text: string): string {
  return `<b>${text}</b>`;
}

function paintBlock(block: ViewBlock, mode: Mode): readonly string[] {
  // Record lookup instead of a switch: a kind added to the union without a
  // painter fails to typecheck at the `PainterMap` declaration.
  const painter = PAINTERS[block.kind] as Painter<ViewBlock["kind"]>;
  return painter(block, mode);
}

/** First line only, capped: an inline slot has one line and no scrollbar. */
function oneLine(text: string): string {
  const index = text.indexOf("\n");
  const first = index < 0 ? text : `${text.slice(0, index).trimEnd()} …`;
  return first.length <= INLINE_LIMIT
    ? first
    : `${first.slice(0, INLINE_LIMIT - 1)}…`;
}

function escapeIn(text: string, mode: Mode): string {
  return MarkdownPainter.escape(mode === "inline" ? oneLine(text) : text);
}

function lines(text: string, mode: Mode): readonly string[] {
  return mode === "inline"
    ? [escapeIn(text, mode)]
    : text.split("\n").map((line) => MarkdownPainter.escape(line));
}

function paintText(block: BlockOf<"text">, mode: Mode): readonly string[] {
  const wrap = TONE_WRAPPERS[block.tone ?? "default"];
  return lines(block.text, mode).map(wrap);
}

function paintSpans(block: BlockOf<"spans">, mode: Mode): readonly string[] {
  return [spansText(block.spans, mode)];
}

function spansText(spans: readonly Span[], mode: Mode): string {
  return spans
    .filter((span) => span.text !== "")
    .map((span) => {
      let text = escapeIn(span.text, mode);
      if (span.code === true) {
        text = `<code>${text}</code>`;
      }
      if (span.strike === true) {
        text = `<s>${text}</s>`;
      }
      if (span.strong === true) {
        text = bold(text);
      }
      return TONE_WRAPPERS[span.tone ?? "default"](text);
    })
    .join("");
}

/**
 * The icon replaces the label when there is one: a glyph reads as a heading on
 * its own, and repeating "Delete" next to a wastebasket adds nothing.
 */
function paintSection(block: BlockOf<"section">): readonly string[] {
  const lead =
    block.icon === undefined
      ? bold(MarkdownPainter.escape(block.label))
      : MarkdownPainter.icon(block.icon);
  const content = MarkdownPainter.paintInline(block.content);
  return [content === "" ? lead : `${lead} ${content}`];
}

function paintCode(block: BlockOf<"code">, mode: Mode): readonly string[] {
  if (mode === "inline") {
    return [`<code>${escapeIn(block.text, mode)}</code>`];
  }
  const start = block.startLine;
  const body = numbered(block.text.split("\n"), start)
    .map((line) => MarkdownPainter.escape(line))
    .join("\n");
  return [preformatted(body, block.lang)];
}

function numbered(
  source: readonly string[],
  start: number | undefined
): readonly string[] {
  if (start === undefined) {
    return source;
  }
  const width = String(start + Math.max(0, source.length - 1)).length;
  return source.map(
    (line, index) => `${String(start + index).padStart(width)} ${line}`
  );
}

function preformatted(body: string, lang?: string): string {
  return lang === undefined || lang === ""
    ? `<pre>${body}</pre>`
    : `<pre><code class="language-${MarkdownPainter.escape(lang)}">${body}</code></pre>`;
}

/**
 * A unified-diff rendering rather than the terminal's two-column one: it is
 * the shape every markdown surface already knows how to highlight.
 */
function paintDiff(block: BlockOf<"diff">, mode: Mode): readonly string[] {
  const body = block.hunks.flatMap((hunk) => diffLines(hunk));
  if (body.length === 0) {
    return [];
  }
  if (mode === "inline") {
    return [`<code>${escapeIn(body[0] ?? "", mode)}</code>`];
  }
  return [
    preformatted(
      body.map((line) => MarkdownPainter.escape(line)).join("\n"),
      "diff"
    ),
  ];
}

function diffLines(hunk: DiffHunk): readonly string[] {
  const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  return [
    header,
    ...hunk.lines.map((line) => `${DIFF_MARKERS[line.kind]}${line.text}`),
  ];
}

const DIFF_MARKERS = {
  context: " ",
  added: "+",
  removed: "-",
} as const;

/** Inline slots have no room for directories, so a path shows as its leaf. */
function paintFile(block: BlockOf<"file">, mode: Mode): readonly string[] {
  const path = mode === "inline" ? basename(block.path) : block.path;
  const range = block.range ? formatRange(block.range) : "";
  const truncated = block.truncated === true ? " (truncated)" : "";
  return [
    `<code>${MarkdownPainter.escape(oneLine(path) + range)}</code>${truncated}`,
  ];
}

function formatRange(range: readonly [number, number | undefined]): string {
  const [start, end] = range;
  return end === undefined ? `:${start}` : `:${start}-${end}`;
}

function paintList(block: BlockOf<"list">, mode: Mode): readonly string[] {
  const markers = block.items.map((_, index) =>
    block.ordered === true ? `${index + 1}.` : "•"
  );
  const width = Math.max(0, ...markers.map((marker) => marker.length)) + 1;
  const indent = " ".repeat(width);

  return block.items.flatMap((item, index) => {
    const marker = (markers[index] ?? "•").padEnd(width);
    return paintBlock(item, mode).map((line, lineIndex) =>
      lineIndex === 0 ? marker + line : indent + line
    );
  });
}

function paintKv(block: BlockOf<"kv">, mode: Mode): readonly string[] {
  return block.pairs.map(
    ([key, value]) =>
      `${bold(`${escapeIn(key, mode)}:`)} ${escapeIn(value, mode)}`
  );
}

function paintLink(block: BlockOf<"link">, mode: Mode): readonly string[] {
  const label =
    block.label === "" || block.label === block.href ? block.href : block.label;
  return [
    `<a href="${MarkdownPainter.escape(block.href)}">${escapeIn(label, mode)}</a>`,
  ];
}

/**
 * Markdown source is escaped, not re-rendered: which markdown dialect the
 * surface speaks is the surface's business, and re-rendering here would emit
 * block tags into slots that only accept inline ones.
 */
function paintMarkdown(
  block: BlockOf<"markdown">,
  mode: Mode
): readonly string[] {
  return lines(block.text, mode);
}

function paintNotice(block: BlockOf<"notice">, mode: Mode): readonly string[] {
  const prefix = NOTICE_PREFIXES[block.severity];
  return lines(block.text, mode).map((line) => `${prefix}${line}`);
}

const PAINTERS: PainterMap = {
  text: paintText,
  markdown: paintMarkdown,
  spans: paintSpans,
  section: paintSection,
  code: paintCode,
  diff: paintDiff,
  file: paintFile,
  list: paintList,
  kv: paintKv,
  link: paintLink,
  notice: paintNotice,
};

const FRAMES = {
  text: "flow",
  markdown: "embed",
  spans: "flow",
  section: "heading",
  code: "embed",
  diff: "embed",
  file: "flow",
  list: "flow",
  kv: "flow",
  link: "flow",
  notice: "flow",
} as const satisfies Record<ViewBlock["kind"], MarkdownFrame>;
