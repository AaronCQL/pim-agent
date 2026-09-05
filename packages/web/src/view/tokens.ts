import { Painting } from "#core/view/Painting";
import type { NoticeSeverity, Tone, ViewBlock } from "#core/view/ViewBlock";

/**
 * How a block sits in a body, matching `MarkdownPainter`'s frames rather than
 * `AnsiPainter`'s: `tight` exists only because a terminal gutter has to give
 * up a column, and HTML has no gutter. `flow` is prose, `embed` is a
 * preformatted payload nothing may re-wrap, `heading` introduces a sub-item.
 */
export type Frame = "flow" | "embed" | "heading";

export const FRAMES = Painting.FRAMES satisfies Record<
  ViewBlock["kind"],
  Frame
>;

/**
 * No cards. Everything sits on the `--line` grid the way terminal output
 * does, so an embed is a scrollable box and nothing more: the fill and radius
 * the old card had would put its first line off the grid by its own padding.
 */
export const FRAME_CLASSES = {
  flow: "flex flex-col",
  embed: "overflow-x-auto",
  heading: "mt-[--line] first:mt-0",
} as const satisfies Record<Frame, string>;

/**
 * The mockup's palette: rose rather than red for failure, indigo for accent —
 * the same hue its send button and unread dot use.
 */
export const TONE_CLASSES = {
  // Inherit: prose reads at the transcript's colour, the same blocks inside a
  // tool body read at the dimmer colour that body sets. A literal neutral-200
  // here would win over both.
  default: "",
  muted: "text-neutral-400",
  dim: "text-neutral-500",
  error: "text-rose-400",
  warning: "text-amber-400",
  accent: "text-indigo-300",
  added: "text-emerald-400",
  removed: "text-rose-400",
  title: "text-neutral-50 font-bold",
} as const satisfies Record<Tone, string>;

export const NOTICE_CLASSES = {
  info: "text-indigo-300",
  warn: "text-amber-400",
  error: "text-rose-400",
} as const satisfies Record<NoticeSeverity, string>;

export const DIFF_LINE_CLASSES = {
  context: "text-neutral-400",
  added: "bg-emerald-500/10 text-emerald-300",
  removed: "bg-rose-500/10 text-rose-300",
} as const;

export function toneClass(tone: Tone | undefined): string {
  return TONE_CLASSES[tone ?? "default"];
}

export type FrameGroup = {
  readonly frame: Frame;
  readonly blocks: readonly ViewBlock[];
};

/**
 * Runs of consecutive same-frame blocks, so one container wraps a whole
 * payload instead of one per line — the same grouping the ANSI and Markdown
 * painters do. Headings are the exception: they are each a sub-item's own
 * boundary, and merging two of them would draw one rule around both files.
 */
export function groupByFrame(
  blocks: readonly ViewBlock[]
): readonly FrameGroup[] {
  return Painting.groupByFrame(blocks, FRAMES, (frame) => frame !== "heading");
}
