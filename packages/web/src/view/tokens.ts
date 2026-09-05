import { Painting } from "../../../core/src/view/Painting";
import type {
  NoticeSeverity,
  Tone,
  ToolIcon,
  ViewBlock,
} from "../../../core/src/view/ViewBlock";

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

export const FRAME_CLASSES = {
  flow: "flex flex-col gap-0.5",
  embed: "my-1 overflow-x-auto rounded bg-neutral-900/60 text-xs",
  heading: "mt-2 first:mt-0 border-l-2 border-neutral-700 pl-2",
} as const satisfies Record<Frame, string>;

export const TONE_CLASSES = {
  default: "text-neutral-200",
  muted: "text-neutral-400",
  dim: "text-neutral-500",
  error: "text-red-400",
  warning: "text-amber-400",
  accent: "text-sky-400",
  added: "text-emerald-400",
  removed: "text-red-400",
  title: "text-neutral-100 font-medium",
} as const satisfies Record<Tone, string>;

export const NOTICE_CLASSES = {
  info: "text-sky-400",
  warn: "text-amber-400",
  error: "text-red-400",
} as const satisfies Record<NoticeSeverity, string>;

export const DIFF_LINE_CLASSES = {
  context: "text-neutral-400",
  added: "bg-emerald-500/10 text-emerald-300",
  removed: "bg-red-500/10 text-red-300",
} as const;

export const ICON_CLASSES = {
  file: "i-lucide-file-text",
  edit: "i-lucide-pencil",
  trash: "i-lucide-trash-2",
  terminal: "i-lucide-terminal",
  search: "i-lucide-search",
  checklist: "i-lucide-list-checks",
  globe: "i-lucide-globe",
  upload: "i-lucide-upload",
  clock: "i-lucide-clock",
  robot: "i-lucide-bot",
} as const satisfies Record<ToolIcon, string>;

export const DEFAULT_ICON_CLASS = "i-lucide-wrench";

export function iconClass(icon: ToolIcon | undefined): string {
  return icon === undefined ? DEFAULT_ICON_CLASS : ICON_CLASSES[icon];
}

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
