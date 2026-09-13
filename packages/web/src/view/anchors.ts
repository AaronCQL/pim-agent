import type { Element } from "solid-js";

import type { ToolDiffLine } from "#core/shared/DiffLines";

/** Which revision a line belongs to: what was taken away, or what stands there now. */
export type DiffSide = "old" | "new";

/** A unified row belongs to the side it changed; a split column says which it is. */
export function diffSide(line: ToolDiffLine): DiffSide {
  return line.kind === "removed" ? "old" : "new";
}

/**
 * How a gutter reads: plain, or held — by a saved comment, or by the selection
 * being swept out right now. One state for both, because they are the same
 * fact to a reader: there is a comment on this line, and the only difference
 * is whether it has been typed yet.
 */
export type AnchorState = "idle" | "held";

/**
 * A diff whose gutters are targets a comment can be anchored to. Absent
 * wherever a diff is painted with nothing to write against — a tool card's.
 */
export type DiffAnchors = {
  /**
   * A gutter pressed, which paints a selection and starts a sweep: what the
   * reader has picked out follows the pointer until it is lifted.
   * `extend` widens the standing selection rather than starting one.
   */
  readonly onPress: (
    line: ToolDiffLine,
    side: DiffSide,
    extend: boolean
  ) => void;
  /**
   * A gutter taken with no pointer to lift — a keyboard activating the button —
   * so the selection is made and settled in one step.
   */
  readonly onPick: (
    line: ToolDiffLine,
    side: DiffSide,
    extend: boolean
  ) => void;
  /** A gutter crossed with the button held, which is the drag that makes a range. */
  readonly onSweep: (line: ToolDiffLine, side: DiffSide) => void;
  readonly stateOf: (side: DiffSide, line: number | undefined) => AnchorState;
  /** Whether anything hangs under a line, so no row is laid out where nothing does. */
  readonly holdsCards: (side: DiffSide, line: number | undefined) => boolean;
  readonly cardsAt: (side: DiffSide, line: number | undefined) => Element;
};
