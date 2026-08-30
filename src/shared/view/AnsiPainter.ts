import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { DiffRenderer } from "../DiffRenderer";
import { Renderer } from "../Renderer";
import type { NoticeSeverity, Span, Tone, ViewBlock } from "./ViewBlock";

type BlockOf<TKind extends ViewBlock["kind"]> = Extract<
  ViewBlock,
  { kind: TKind }
>;

type Painter<TKind extends ViewBlock["kind"]> = (
  block: BlockOf<TKind>,
  theme: Theme
) => readonly string[];

type PainterMap = { readonly [TKind in ViewBlock["kind"]]: Painter<TKind> };

/**
 * How a block sits relative to the container the caller draws around a body.
 * `flow` is ordinary output the container may restyle and re-wrap; `embed` is
 * preformatted and already coloured, so the container must leave it alone;
 * `heading` steps outside the container entirely.
 */
export type BlockFrame = "flow" | "embed" | "tight" | "heading";

/**
 * Markdown wraps at the render-time width, so a body hands the source on to
 * the caller instead of pre-painted lines.
 */
export type PaintedGroup =
  | { readonly frame: BlockFrame; readonly lines: readonly string[] }
  | { readonly frame: "embed"; readonly markdown: string };

/**
 * Paints a `ViewBlock` tree to ANSI lines. Returns plain strings rather than
 * pi-tui components so the same output can be asserted in unit tests and
 * wrapped by whichever container the caller already uses.
 */
export class AnsiPainter {
  public static paint(blocks: readonly ViewBlock[], theme: Theme): string[] {
    return blocks.flatMap((block) => paintBlock(block, theme));
  }

  /**
   * Flattens title blocks to the one line a title renderer draws. Markdown is
   * handed over unpainted, since it needs the width the title renderer knows.
   */
  public static paintTitle(
    blocks: readonly ViewBlock[],
    theme: Theme
  ): { readonly text: string; readonly markdown: boolean } {
    const only = blocks.length === 1 ? blocks[0] : undefined;
    if (only?.kind === "markdown") {
      return { text: only.text, markdown: true };
    }
    return {
      text: AnsiPainter.paint(blocks, theme).join(" "),
      markdown: false,
    };
  }

  /** The theme colour a tone maps to, or undefined for the default colour. */
  public static themeColorFor(tone: Tone | undefined): ThemeColor | undefined {
    return tone === undefined || tone === "default"
      ? undefined
      : TONE_COLORS[tone];
  }

  /**
   * Paints a body, keeping adjacent blocks that share a frame together so the
   * caller draws one container per run instead of one per block.
   */
  public static paintBody(
    blocks: readonly ViewBlock[],
    theme: Theme
  ): PaintedGroup[] {
    const groups: PaintedGroup[] = [];
    let open: { frame: BlockFrame; lines: string[] } | undefined;

    for (const block of blocks) {
      if (block.kind === "markdown") {
        open = undefined;
        groups.push({ frame: "embed", markdown: block.text });
        continue;
      }

      const frame = FRAMES[block.kind];
      const lines = paintBlock(block, theme);

      if (open?.frame === frame) {
        open.lines.push(...lines);
      } else {
        open = { frame, lines: [...lines] };
        groups.push(open);
      }
    }

    return groups;
  }
}

const TONE_COLORS = {
  muted: "muted",
  dim: "dim",
  error: "error",
  warning: "warning",
  accent: "accent",
  added: "toolDiffAdded",
  removed: "toolDiffRemoved",
  title: "toolTitle",
} as const satisfies Record<Exclude<Tone, "default">, ThemeColor>;

const NOTICE_COLORS = {
  info: "muted",
  warn: "warning",
  error: "error",
} as const satisfies Record<NoticeSeverity, ThemeColor>;

function paintBlock(block: ViewBlock, theme: Theme): readonly string[] {
  // Record lookup instead of a switch: a kind added to the union without a
  // painter fails to typecheck at the `PainterMap` declaration.
  const painter = PAINTERS[block.kind] as Painter<ViewBlock["kind"]>;
  return painter(block, theme);
}

function paintText(block: BlockOf<"text">, theme: Theme): readonly string[] {
  const lines = block.text.split("\n");
  const tone = block.tone ?? "default";

  if (tone === "default") {
    return lines;
  }

  return lines.map((line) => theme.fg(TONE_COLORS[tone], line));
}

/** An empty span carries no content to style, so it contributes nothing. */
function spansText(spans: readonly Span[], theme: Theme): string {
  return spans
    .filter((span) => span.text !== "")
    .map((span) => {
      const text =
        span.strike === true ? theme.strikethrough(span.text) : span.text;
      const tone = span.tone ?? "default";
      return tone === "default" ? text : theme.fg(TONE_COLORS[tone], text);
    })
    .join("");
}

function paintSpans(block: BlockOf<"spans">, theme: Theme): readonly string[] {
  return [spansText(block.spans, theme)];
}

/**
 * The leading blank is part of the heading: a section always opens a new group
 * and needs separating from whatever precedes it, in every painter.
 */
function paintSection(
  block: BlockOf<"section">,
  theme: Theme
): readonly string[] {
  return [
    "",
    Renderer.toolTitleText({
      label: block.label,
      title: spansText(block.content, theme),
      theme,
      markerColor: "success",
    }),
  ];
}

/**
 * No syntax highlighting: pi's `highlightCode` reads the process-global theme,
 * which this painter deliberately does not depend on. `lang` still travels in
 * the model for painters that can use it (Markdown fences, web highlighters).
 */
function paintCode(block: BlockOf<"code">, theme: Theme): readonly string[] {
  const lines = block.text.split("\n");
  const start = block.startLine;

  if (start === undefined) {
    return lines;
  }

  const width = String(start + Math.max(0, lines.length - 1)).length;
  return lines.map(
    (line, index) =>
      theme.fg("muted", `${String(start + index).padStart(width)} `) + line
  );
}

function paintDiff(block: BlockOf<"diff">, theme: Theme): readonly string[] {
  const rendered = DiffRenderer.render({
    toolDiff: { path: block.path, hunks: block.hunks },
    theme,
  });
  return rendered === "" ? [] : rendered.split("\n");
}

function paintFile(block: BlockOf<"file">, theme: Theme): readonly string[] {
  const range = block.range ? formatRange(block.range) : "";
  const truncated = block.truncated === true ? " (truncated)" : "";
  const suffix = `${range}${truncated}`;
  return [suffix === "" ? block.path : block.path + theme.fg("muted", suffix)];
}

function formatRange(range: readonly [number, number | undefined]): string {
  const [start, end] = range;
  return end === undefined ? `:${start}` : `:${start}-${end}`;
}

function paintList(block: BlockOf<"list">, theme: Theme): readonly string[] {
  const markers = block.items.map((_, index) =>
    block.ordered === true ? `${index + 1}.` : "•"
  );
  const width = Math.max(0, ...markers.map((marker) => marker.length)) + 1;
  const indent = " ".repeat(width);

  return block.items.flatMap((item, index) => {
    const marker = theme.fg("muted", (markers[index] ?? "•").padEnd(width));
    return paintBlock(item, theme).map((line, lineIndex) =>
      lineIndex === 0 ? marker + line : indent + line
    );
  });
}

function paintKv(block: BlockOf<"kv">, theme: Theme): readonly string[] {
  const width = Math.max(0, ...block.pairs.map(([key]) => key.length + 1));
  return block.pairs.map(
    ([key, value]) => theme.fg("muted", `${key}:`.padEnd(width + 1)) + value
  );
}

function paintLink(block: BlockOf<"link">, theme: Theme): readonly string[] {
  if (block.label === "" || block.label === block.href) {
    return [theme.fg("mdLinkUrl", block.href)];
  }
  return [
    `${theme.fg("mdLink", block.label)} ${theme.fg("mdLinkUrl", block.href)}`,
  ];
}

/**
 * The width-free fallback: a body defers markdown to the caller (see
 * `paintBody`), so this only runs where there is no width to wrap at, and the
 * source text is the closest honest rendering.
 */
function paintMarkdown(block: BlockOf<"markdown">): readonly string[] {
  return block.text.split("\n");
}

function paintNotice(
  block: BlockOf<"notice">,
  theme: Theme
): readonly string[] {
  const color = NOTICE_COLORS[block.severity];
  return block.text.split("\n").map((line) => theme.fg(color, line));
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
  // Markdown carries its own SGR state; re-colouring it corrupts it.
  markdown: "embed",
  spans: "flow",
  section: "heading",
  code: "flow",
  // Diff lines carry their own SGR state too, and paint their own leading
  // column, so the gutter has to give that column up.
  diff: "tight",
  file: "flow",
  list: "flow",
  kv: "flow",
  link: "flow",
  notice: "flow",
} as const satisfies Record<ViewBlock["kind"], BlockFrame>;
