import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { DiffRenderer } from "../shared/DiffRenderer";
import { Renderer } from "../shared/Renderer";
import { type BlockFrame, Painting, type PainterMap } from "./Painting";
import type {
  BlockOf,
  NoticeSeverity,
  Span,
  Tone,
  ViewBlock,
} from "./ViewBlock";

export type { BlockFrame } from "./Painting";

export type PaintedGroup =
  | {
      readonly frame: Exclude<BlockFrame, "embed">;
      readonly lines: readonly string[];
    }
  | { readonly frame: "embed"; readonly markdown: string };

function paint(blocks: readonly ViewBlock[], theme: Theme): string[] {
  return blocks.flatMap((block) => paintBlock(block, theme));
}

function paintTitle(
  blocks: readonly ViewBlock[],
  theme: Theme
): { readonly text: string; readonly markdown: boolean } {
  const only = blocks.length === 1 ? blocks[0] : undefined;
  if (only?.kind === "markdown") {
    return { text: only.text, markdown: true };
  }
  return {
    text: paint(blocks, theme).join(" "),
    markdown: false,
  };
}

function themeColorFor(tone: Tone | undefined): ThemeColor | undefined {
  return tone === undefined || tone === "default"
    ? undefined
    : TONE_COLORS[tone];
}

function paintBody(blocks: readonly ViewBlock[], theme: Theme): PaintedGroup[] {
  return Painting.groupByFrame(
    blocks,
    FRAMES,
    (frame) => frame !== "embed"
  ).map((group): PaintedGroup => {
    const [first] = group.blocks;
    if (first?.kind === "markdown") {
      return { frame: "embed", markdown: first.text };
    }
    return {
      frame: group.frame as Exclude<BlockFrame, "embed">,
      lines: group.blocks.flatMap((block) => paintBlock(block, theme)),
    };
  });
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
  return Painting.dispatch(PAINTERS, block, theme);
}

function paintText(block: BlockOf<"text">, theme: Theme): readonly string[] {
  const lines = block.text.split("\n");
  const tone = block.tone ?? "default";

  if (tone === "default") {
    return lines;
  }

  return lines.map((line) => theme.fg(TONE_COLORS[tone], line));
}

function spansText(spans: readonly Span[], theme: Theme): string {
  return spans
    .filter((span) => span.text !== "")
    .map((span) => {
      let text =
        span.strike === true ? theme.strikethrough(span.text) : span.text;
      if (span.strong === true) {
        text = theme.bold(text);
      }
      const tone = span.tone ?? "default";
      return tone === "default" ? text : theme.fg(TONE_COLORS[tone], text);
    })
    .join("");
}

function paintSpans(block: BlockOf<"spans">, theme: Theme): readonly string[] {
  return [spansText(block.spans, theme)];
}

function paintSection(
  block: BlockOf<"section">,
  theme: Theme
): readonly string[] {
  return [
    "",
    Renderer.toolTitleText({
      label: block.label,
      title: paint(block.content, theme).join(" "),
      theme,
      markerColor: "success",
    }),
  ];
}

function paintCode(block: BlockOf<"code">, theme: Theme): readonly string[] {
  const lines = block.text.split("\n");
  const start = block.startLine;

  if (start === undefined) {
    return lines;
  }

  const width = Painting.lineNumberWidth(start, lines.length);
  return lines.map(
    (line, index) =>
      theme.fg("muted", `${String(start + index).padStart(width)} `) + line
  );
}

function paintDiff(block: BlockOf<"diff">, theme: Theme): readonly string[] {
  return DiffRenderer.renderLines({
    toolDiff: { path: block.path, hunks: block.hunks },
    theme,
  });
}

function paintFile(block: BlockOf<"file">, theme: Theme): readonly string[] {
  const { range, truncated } = Painting.fileSuffix(block);
  const suffix = `${range}${truncated}`;
  return [suffix === "" ? block.path : block.path + theme.fg("muted", suffix)];
}

function paintList(block: BlockOf<"list">, theme: Theme): readonly string[] {
  return Painting.hangingList(
    block.items,
    block.ordered === true,
    (item) => paintBlock(item, theme),
    (marker) => theme.fg("muted", marker)
  );
}

function paintKv(block: BlockOf<"kv">, theme: Theme): readonly string[] {
  const width = Math.max(0, ...block.pairs.map(([key]) => key.length + 1));
  return block.pairs.map(
    ([key, value]) => theme.fg("muted", `${key}:`.padEnd(width + 1)) + value
  );
}

function paintLink(block: BlockOf<"link">, theme: Theme): readonly string[] {
  const label = Painting.linkLabel(block);
  if (label === block.href) {
    return [theme.fg("mdLinkUrl", block.href)];
  }
  return [`${theme.fg("mdLink", label)} ${theme.fg("mdLinkUrl", block.href)}`];
}

function paintAttachment(
  block: BlockOf<"attachment">,
  theme: Theme
): readonly string[] {
  return [`${theme.fg("muted", "sent")} ${block.name}`];
}

function paintImage(block: BlockOf<"image">, theme: Theme): readonly string[] {
  return [theme.fg("muted", Painting.imageSummary(block))];
}

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

const PAINTERS: PainterMap<readonly string[], [Theme]> = {
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

const FRAMES = {
  ...Painting.FRAMES,
  code: "flow",
  diff: "tight",
} as const satisfies Record<ViewBlock["kind"], BlockFrame>;

/** Paints a `ViewBlock` tree to ANSI lines. */
export const AnsiPainter = { paint, paintTitle, themeColorFor, paintBody };
