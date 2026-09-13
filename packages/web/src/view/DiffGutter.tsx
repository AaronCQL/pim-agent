import type { Element } from "solid-js";

import type { ToolDiffLine, ToolDiffLineKind } from "#core/shared/DiffLines";
import { lineNumberOf, type DiffAnchors, type DiffSide } from "./anchors";

// `−` is the unicode minus, which lines up with `+`.
const SIGNS = {
  context: " ",
  added: "+",
  removed: "−",
} as const satisfies Record<ToolDiffLineKind, string>;

/**
 * What a gutter reads: the line's number in its own side's file, then the sign
 * of what happened to it. A filler has neither and keeps the width all the same.
 */
export function gutterText(
  line: ToolDiffLine | undefined,
  side: DiffSide,
  width: number
): string {
  const number = lineNumberOf(line, side);
  return ` ${String(number ?? "").padStart(width)} ${SIGNS[line?.kind ?? "context"]} `;
}

/**
 * A gutter a comment can be anchored to, in whichever layout is painting it:
 * the two differ in the classes they dress the cell in, and must not differ in
 * the gestures that pick a line out.
 */
export function DiffGutter(props: {
  readonly line: ToolDiffLine;
  readonly side: DiffSide;
  readonly width: number;
  readonly anchors: DiffAnchors;
  /** How the painter dresses its own cell; the gesture rules are added here. */
  readonly class: string;
}): Element {
  return (
    <button
      type="button"
      aria-label={`Comment on ${props.side} line ${lineNumberOf(props.line, props.side) ?? ""}`}
      // A finger drawn down the gutter is a range rather than a scroll, and
      // only the compositor can be told so beforehand: the gutter keeps
      // sideways panning and gives up the vertical. The code beside it scrolls
      // as it always did. Written out in full rather than with the shorthand
      // utility, which leans on two further variables registered with no
      // initial value and so voids itself.
      class={`select-none [touch-action:pan-x] ${props.class}`}
      onClick={(event) => {
        // A keyboard reports no clicks; the pointer has its own path.
        if (event.detail === 0) {
          props.anchors.onPick(props.line, props.side, event.shiftKey);
        }
      }}
      onPointerDown={(event) => {
        if (event.button === 0) {
          // A press that draws a range must not also drag a text selection
          // through the code it is drawn beside.
          event.preventDefault();
          // Touch captures the pointer to the element it went down on, which
          // would keep every gutter it then crosses from hearing it.
          event.currentTarget.releasePointerCapture(event.pointerId);
          props.anchors.onPress(props.line, props.side, event.shiftKey);
        }
      }}
      onPointerEnter={(event) => {
        if (event.buttons === 1) {
          props.anchors.onSweep(props.line, props.side);
        }
      }}
    >
      {gutterText(props.line, props.side, props.width)}
    </button>
  );
}
