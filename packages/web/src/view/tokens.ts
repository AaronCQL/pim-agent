import { Painting } from "#core/view/Painting";
import type { NoticeSeverity, Tone, ViewBlock } from "#core/view/ViewBlock";
import type { ToolDiffLineKind } from "#core/shared/DiffLines";
import type { SyntaxRole } from "./highlight";

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
  // Inherit: prose reads at the transcript's colour, including inside a tool
  // body. A literal neutral-200 here would win over both.
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

/**
 * The palette of pim's terminal themes, in web hues: `syntaxKeyword` and
 * `syntaxVariable` are one colour there and are one colour here, operators
 * and punctuation are left uncoloured there and inherit here. What the roles
 * mean is fixed by `highlight.ts`; this is only what they look like.
 *
 * Function green and diff green are deliberately different weights of the
 * same hue rather than different hues: a function name on an added line is
 * green-on-green in the terminal too, and it reads.
 */
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
  // The same greens and roses a rendered diff uses, so a ```diff fence and a
  // tool's diff body read as the same thing.
  added: "text-emerald-400",
  removed: "text-rose-400",
} as const satisfies Record<SyntaxRole, string>;

export function syntaxClass(role: SyntaxRole | undefined): string {
  return role === undefined ? "" : SYNTAX_CLASSES[role];
}

/**
 * A diff line is drawn in three layers, the way the terminal draws it: a wash
 * over the whole row, a brighter wash over just the characters that changed,
 * and a gutter that names the line. None of them touches the foreground —
 * that belongs to the syntax highlighter, which is the point of the exercise.
 */
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

export function toneClass(tone: Tone | undefined): string {
  return TONE_CLASSES[tone ?? "default"];
}

/**
 * The mark a tool row hangs off — the caret when there is something behind it
 * and the square when there is not, since which of the two it is says nothing
 * about how the call went: neutral, amber while it is still in flight — the
 * `warning` tone's own tint — and rose once it has failed.
 */
export function caretClass(isPartial: boolean, isError: boolean): string {
  if (isPartial) {
    return "bg-amber-400";
  }
  return isError ? "bg-rose-400" : "bg-neutral-300";
}

/**
 * The rule that hangs off that caret, and its hover. It reads the same state
 * the caret does and in the same hues: a call still in flight is amber all the
 * way down, a failed one rose, so a row that wraps or opens says what it is
 * with its whole height rather than with one glyph at the top of it.
 *
 * The resting colour is the exception. A settled row's caret is `neutral-300`
 * and its spine is far dimmer, because the two are not doing the same job:
 * the caret marks a row in a list of rows, the rule only shows how far one of
 * them reaches, and a transcript of them at caret strength would be a page of
 * ruled lines.
 *
 * The hover is `group-hover`, not `hover`: the grip lights when the pointer
 * is anywhere on the row, which is the same reach the row already brightens
 * over.
 */
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
