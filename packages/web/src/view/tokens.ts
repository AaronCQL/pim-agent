import { Painting } from "#core/view/Painting";
import type { NoticeSeverity, Tone, ViewBlock } from "#core/view/ViewBlock";
import type { ToolDiffLineKind } from "#core/shared/DiffLines";
import type { SyntaxRole } from "./highlight";

/** How a block sits in a body: prose, a payload nothing may re-wrap, or a heading. */
export type Frame = "flow" | "embed" | "heading";

export const FRAMES = Painting.FRAMES satisfies Record<
  ViewBlock["kind"],
  Frame
>;

export const FRAME_CLASSES = {
  flow: "flex flex-col",
  embed: "overflow-x-auto",
  heading: "mt-[--line] first:mt-0",
} as const satisfies Record<Frame, string>;

export const TONE_CLASSES = {
  // Empty: prose inherits the transcript's colour, including inside a tool body.
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
  info: "text-neutral-400",
  warn: "text-amber-400",
  error: "text-rose-400",
} as const satisfies Record<NoticeSeverity, string>;

export const SYNTAX_CLASSES = {
  keyword: "text-fuchsia-300",
  variable: "text-fuchsia-300",
  type: "text-cyan-300",
  function: "text-emerald-300",
  string: "text-amber-300",
  number: "text-sky-300",
  comment: "text-neutral-500",
  meta: "text-neutral-400",
  operator: "",
  punctuation: "",
  added: "text-emerald-400",
  removed: "text-rose-400",
} as const satisfies Record<SyntaxRole, string>;

export function syntaxClass(role: SyntaxRole | undefined): string {
  return role === undefined ? "" : SYNTAX_CLASSES[role];
}

export const DIFF_ROW_CLASSES = {
  context: "",
  added: "bg-emerald-500/8",
  removed: "bg-rose-500/8",
} as const satisfies Record<ToolDiffLineKind, string>;

export const DIFF_EMPHASIS_CLASSES = {
  context: "",
  added: "bg-emerald-500/16",
  removed: "bg-rose-500/16",
} as const satisfies Record<ToolDiffLineKind, string>;

export const DIFF_GUTTER_CLASSES = {
  context: "text-neutral-600",
  added: "text-emerald-400",
  removed: "text-rose-400",
} as const satisfies Record<ToolDiffLineKind, string>;

/**
 * The half of a split pair whose side has no line there: not a blank line, but
 * no line at all. Hatched, defined in `styles.css` — the two say different
 * things and a reader has to be able to tell them apart at a glance. The text
 * column wears it alone: a gradient restarts in every box it is given, so a
 * hatched gutter beside a hatched line would show the phase break between them.
 */
export const DIFF_FILLER_CLASS = "pim-diff-filler";

/**
 * The gap between two hunks: code that exists and is not being shown. A flat
 * wash, because unlike a filler it stands for something a reader could ask for.
 */
export const DIFF_GAP_CLASS = "bg-neutral-500/10";

export function toneClass(tone: Tone | undefined): string {
  return TONE_CLASSES[tone ?? "default"];
}

export function caretClass(isPartial: boolean, isError: boolean): string {
  if (isPartial) {
    return "bg-amber-400";
  }
  return isError ? "bg-rose-400" : "bg-neutral-300";
}

export function spineClass(isPartial: boolean, isError: boolean): string {
  if (isPartial) {
    return "text-amber-400 group-hover:text-amber-300";
  }
  return isError
    ? "text-rose-400 group-hover:text-rose-300"
    : "text-neutral-750 group-hover:text-neutral-500";
}

export type FrameGroup = {
  readonly frame: Frame;
  readonly blocks: readonly ViewBlock[];
};

/** Runs of consecutive same-frame blocks; headings never merge with a neighbour. */
export function groupByFrame(
  blocks: readonly ViewBlock[]
): readonly FrameGroup[] {
  return Painting.groupByFrame(blocks, FRAMES, (frame) => frame !== "heading");
}
