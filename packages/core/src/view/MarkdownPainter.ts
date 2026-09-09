import { basename } from "node:path";
import { Painting, type PainterMap } from "./Painting";
import type {
  BlockOf,
  DiffHunk,
  NoticeSeverity,
  Span,
  Tone,
  ToolIcon,
  ToolView,
  ViewBlock,
} from "./ViewBlock";

type Mode = "inline" | "block";

/** How a block sits in a body; `embed` payloads must never be re-wrapped. */
export type MarkdownFrame = "flow" | "embed" | "heading";

export type MarkdownGroup = {
  readonly frame: MarkdownFrame;
  readonly lines: readonly string[];
};

export type PaintedTool = {
  readonly icon: string;
  readonly lines: readonly string[];
};

const INLINE_LIMIT = 180;

const ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function escape(text: string): string {
  return text.replace(/[&<>"]/g, (char) => ENTITIES[char] ?? char);
}

function paint(blocks: readonly ViewBlock[]): string[] {
  return blocks.flatMap((block) => paintBlock(block, "block"));
}

function paintInline(blocks: readonly ViewBlock[]): string {
  return blocks
    .flatMap((block) => paintBlock(block, "inline"))
    .filter((line) => line !== "")
    .join(" ");
}

function paintBody(blocks: readonly ViewBlock[]): MarkdownGroup[] {
  return Painting.groupByFrame(blocks, Painting.FRAMES).map((group) => ({
    frame: group.frame,
    lines: group.blocks.flatMap((block) => paintBlock(block, "block")),
  }));
}

function icon(toolIcon: ToolIcon | undefined): string {
  return toolIcon === undefined ? DEFAULT_ICON : ICONS[toolIcon];
}

function paintTool(view: ToolView): PaintedTool {
  const head = [view.title, view.summary ?? []]
    .map((blocks) => paintInline(blocks))
    .filter((text) => text !== "")
    .join(" ");
  const outline = outlined(view.body ?? []).flatMap((block) =>
    paintBlock(block, "block")
  );

  return {
    icon: icon(view.icon),
    lines: [head, ...outline].filter((line) => line !== ""),
  };
}

/** A chat row carries a body's headings and any payload that fits a line; an embedded one needs a screen. */
function outlined(blocks: readonly ViewBlock[]): readonly ViewBlock[] {
  return blocks.filter((block) => {
    const frame = Painting.FRAMES[block.kind];
    return (
      frame === "heading" ||
      (frame === "flow" && Painting.WEIGHT[block.kind] === "payload")
    );
  });
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
  return Painting.dispatch(PAINTERS, block, mode);
}

function oneLine(text: string): string {
  const index = text.indexOf("\n");
  const first = index < 0 ? text : `${text.slice(0, index).trimEnd()} …`;
  return first.length <= INLINE_LIMIT
    ? first
    : `${first.slice(0, INLINE_LIMIT - 1)}…`;
}

function escapeIn(text: string, mode: Mode): string {
  return escape(mode === "inline" ? oneLine(text) : text);
}

function lines(text: string, mode: Mode): readonly string[] {
  return mode === "inline"
    ? [escapeIn(text, mode)]
    : text.split("\n").map((line) => escape(line));
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

function paintSection(block: BlockOf<"section">): readonly string[] {
  const lead =
    block.icon === undefined ? bold(escape(block.label)) : icon(block.icon);
  const content = paintInline(block.content);
  return [content === "" ? lead : `${lead} ${content}`];
}

function paintCode(block: BlockOf<"code">, mode: Mode): readonly string[] {
  if (mode === "inline") {
    return [`<code>${escapeIn(block.text, mode)}</code>`];
  }
  const start = block.startLine;
  const body = numbered(block.text.split("\n"), start)
    .map((line) => escape(line))
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
  const width = Painting.lineNumberWidth(start, source.length);
  return source.map(
    (line, index) => `${String(start + index).padStart(width)} ${line}`
  );
}

function preformatted(body: string, lang?: string): string {
  return lang === undefined || lang === ""
    ? `<pre>${body}</pre>`
    : `<pre><code class="language-${escape(lang)}">${body}</code></pre>`;
}

function paintDiff(block: BlockOf<"diff">, mode: Mode): readonly string[] {
  const body = block.hunks.flatMap((hunk) => diffLines(hunk));
  if (body.length === 0) {
    return [];
  }
  if (mode === "inline") {
    return [`<code>${escapeIn(body[0] ?? "", mode)}</code>`];
  }
  return [preformatted(body.map((line) => escape(line)).join("\n"), "diff")];
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

function paintFile(block: BlockOf<"file">, mode: Mode): readonly string[] {
  const path = mode === "inline" ? basename(block.path) : block.path;
  const { range, truncated } = Painting.fileSuffix(block);
  return [`<code>${escape(oneLine(path) + range)}</code>${truncated}`];
}

function paintList(block: BlockOf<"list">, mode: Mode): readonly string[] {
  return Painting.hangingList(block.items, block.ordered === true, (item) =>
    paintBlock(item, mode)
  );
}

function paintKv(block: BlockOf<"kv">, mode: Mode): readonly string[] {
  return block.pairs.map(
    ([key, value]) =>
      `${bold(`${escapeIn(key, mode)}:`)} ${escapeIn(value, mode)}`
  );
}

function paintLink(block: BlockOf<"link">, mode: Mode): readonly string[] {
  const label = Painting.linkLabel(block);
  return [`<a href="${escape(block.href)}">${escapeIn(label, mode)}</a>`];
}

function paintAttachment(
  block: BlockOf<"attachment">,
  mode: Mode
): readonly string[] {
  return [escapeIn(block.name, mode)];
}

function paintImage(block: BlockOf<"image">, mode: Mode): readonly string[] {
  return [escapeIn(Painting.imageSummary(block), mode)];
}

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

const PAINTERS: PainterMap<readonly string[], [Mode]> = {
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
  attachment: paintAttachment,
  image: paintImage,
  notice: paintNotice,
};

/** Paints a `ViewBlock` tree to Telegram-flavoured HTML; the caller joins lines. */
export const MarkdownPainter = {
  escape,
  paint,
  paintInline,
  paintBody,
  icon,
  paintTool,
};
