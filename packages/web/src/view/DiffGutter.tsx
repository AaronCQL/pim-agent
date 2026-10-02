import type { Element } from "solid-js";

import type { ToolDiffLine, ToolDiffLineKind } from "#core/shared/DiffLines";
import { lineNumberOf, type DiffAnchors, type DiffSide } from "./anchors";

// `−` is the unicode minus, which lines up with `+`.
const SIGNS = {
  context: " ",
  added: "+",
  removed: "−",
} as const satisfies Record<ToolDiffLineKind, string>;

export function gutterText(
  line: ToolDiffLine | undefined,
  side: DiffSide,
  width: number
): string {
  const number = lineNumberOf(line, side);
  return ` ${String(number ?? "").padStart(width)} ${SIGNS[line?.kind ?? "context"]} `;
}

/** Shared by the unified and split layouts so the gestures stay identical. */
export function DiffGutter(props: {
  readonly line: ToolDiffLine;
  readonly side: DiffSide;
  readonly width: number;
  readonly anchors: DiffAnchors;
  readonly class: string;
}): Element {
  return (
    <button
      type="button"
      aria-label={`Comment on ${props.side} line ${lineNumberOf(props.line, props.side) ?? ""}`}
      // A vertical drag selects a range instead of scrolling. Spelled out
      // because the `touch-pan-x` utility relies on unset variables.
      class={`select-none [touch-action:pan-x] ${props.class}`}
      onClick={(event) => {
        // Keyboard only (`detail` 0); pointers go through `onPointerDown`.
        if (event.detail === 0) {
          props.anchors.onPick(props.line, props.side, event.shiftKey);
        }
      }}
      onPointerDown={(event) => {
        if (event.button === 0) {
          // No text selection while dragging a range.
          event.preventDefault();
          // Touch implicitly captures; release so other gutters get `pointerenter`.
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
