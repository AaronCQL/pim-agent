import { Painting } from "#core/view/Painting";
import type { NoticeSeverity, Tone, ViewBlock } from "#core/view/ViewBlock";
import type { ToolDiffLineKind } from "#core/shared/DiffLines";
import type { AnchorState } from "./anchors";
import type { SyntaxRole } from "./highlight";

/** `embed` is a payload that must not re-wrap. */
export type Frame = "flow" | "embed" | "heading";

const FRAMES = Painting.FRAMES satisfies Record<ViewBlock["kind"], Frame>;

export const FRAME_CLASSES = {
  flow: "flex flex-col",
  embed: "overflow-x-auto",
  heading: "mt-[--line] first:mt-0",
} as const satisfies Record<Frame, string>;

export const TONE_CLASSES = {
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

/** `.pim-diff-held` (styles.css) is opaque, hiding the row tint behind the gutter. */
export const DIFF_ANCHOR_CLASSES = {
  idle: "hover:bg-indigo-500/12 hover:text-indigo-300",
  held: "pim-diff-held text-indigo-200",
} as const satisfies Record<AnchorState, string>;

export function diffAnchorClass(
  kind: ToolDiffLineKind,
  state: AnchorState,
  target: boolean
): string {
  if (state === "held") {
    return DIFF_ANCHOR_CLASSES.held;
  }
  return target
    ? `${DIFF_GUTTER_CLASSES[kind]} ${DIFF_ANCHOR_CLASSES.idle}`
    : DIFF_GUTTER_CLASSES[kind];
}

/** For split cells, which carry the row tint themselves; a held gutter drops it. */
export function diffGutterClass(
  kind: ToolDiffLineKind,
  state: AnchorState,
  target: boolean
): string {
  const ink = diffAnchorClass(kind, state, target);
  return state === "held" ? ink : `${DIFF_ROW_CLASSES[kind]} ${ink}`;
}

/**
 * Hatched (styles.css) split-view cell with no line. Put it on the text column
 * only: on the gutter too, the gradient's phase break would show.
 */
export const DIFF_FILLER_CLASS = "pim-diff-filler";

/** Hidden lines between two hunks. */
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

type FrameGroup = {
  readonly frame: Frame;
  readonly blocks: readonly ViewBlock[];
};

/** Headings never merge with a neighbour. */
export function groupByFrame(
  blocks: readonly ViewBlock[]
): readonly FrameGroup[] {
  return Painting.groupByFrame(blocks, FRAMES, (frame) => frame !== "heading");
}
