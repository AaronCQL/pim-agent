import type { Element } from "solid-js";

import type { ToolDiffLine } from "#core/shared/DiffLines";

export type DiffSide = "old" | "new";

export function diffSide(line: ToolDiffLine): DiffSide {
  return line.kind === "removed" ? "old" : "new";
}

/** Undefined for a split view's filler cell. */
export function lineNumberOf(
  line: ToolDiffLine | undefined,
  side: DiffSide
): number | undefined {
  return side === "old" ? line?.oldLine : line?.newLine;
}

/** `held`: the line has a saved comment or is in the current selection. */
export type AnchorState = "idle" | "held";

/** Makes diff gutters comment targets; absent on read-only diffs such as tool cards. */
export type DiffAnchors = {
  /** Pointer down: starts a drag selection. `extend` (Shift) widens the current one. */
  readonly onPress: (
    line: ToolDiffLine,
    side: DiffSide,
    extend: boolean
  ) => void;
  /** Keyboard activation: selects and settles in one step. */
  readonly onPick: (
    line: ToolDiffLine,
    side: DiffSide,
    extend: boolean
  ) => void;
  /** Pointer entered a gutter with the button held. */
  readonly onSweep: (line: ToolDiffLine, side: DiffSide) => void;
  readonly stateOf: (side: DiffSide, line: number | undefined) => AnchorState;
  readonly holdsCards: (side: DiffSide, line: number | undefined) => boolean;
  readonly cardsAt: (side: DiffSide, line: number | undefined) => Element;
};
