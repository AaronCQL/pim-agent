import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { DiffRenderer } from "../DiffRenderer";
import type { NoticeSeverity, ViewBlock } from "./ViewBlock";

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
 * Paints a `ViewBlock` tree to ANSI lines. Returns plain strings rather than
 * pi-tui components so the same output can be asserted in unit tests and
 * wrapped by whichever container the caller already uses.
 */
export class AnsiPainter {
  public static paint(blocks: readonly ViewBlock[], theme: Theme): string[] {
    return blocks.flatMap((block) => paintBlock(block, theme));
  }
}

const TONE_COLORS = {
  muted: "muted",
  error: "error",
} as const satisfies Record<string, ThemeColor>;

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

function paintNotice(
  block: BlockOf<"notice">,
  theme: Theme
): readonly string[] {
  const color = NOTICE_COLORS[block.severity];
  return block.text.split("\n").map((line) => theme.fg(color, line));
}

const PAINTERS: PainterMap = {
  text: paintText,
  code: paintCode,
  diff: paintDiff,
  file: paintFile,
  list: paintList,
  kv: paintKv,
  link: paintLink,
  notice: paintNotice,
};
