import type { JSX } from "@solidjs/web/jsx-runtime";
import { onCleanup } from "solid-js";

import type { Point } from "./Popover";

const HOLD_MS = 450;

/** How far a finger may wander and still be holding still rather than scrolling. */
const SLOP = 10;

type Handlers = Pick<
  JSX.HTMLAttributes<HTMLElement>,
  | "onContextMenu"
  | "onPointerDown"
  | "onPointerMove"
  | "onPointerUp"
  | "onPointerCancel"
>;

export type PressMenu = {
  /** Spread onto the element the verbs belong to. */
  readonly handlers: Handlers;
  /**
   * Whether the press that just ended was the one that opened the menu, which
   * the element must not also read as a tap. Answering clears it.
   */
  readonly swallowed: () => boolean;
};

/**
 * The two ways a pointer asks a row for its verbs: a right-click, and a finger
 * held still. Both say where they landed, so the menu can open under the
 * pointer that asked for it rather than off at the row's own trigger.
 */
export function createPressMenu(open: (at: Point) => void): PressMenu {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let origin: Point | undefined;
  let fired = false;

  const stop = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    origin = undefined;
  };

  onCleanup(stop);

  return {
    swallowed: () => {
      const held = fired;
      fired = false;
      return held;
    },
    handlers: {
      onContextMenu: (event) => {
        event.preventDefault();
        open({ x: event.clientX, y: event.clientY });
      },
      onPointerDown: (event) => {
        fired = false;
        if (event.pointerType === "mouse") {
          return;
        }
        const at: Point = { x: event.clientX, y: event.clientY };
        origin = at;
        timer = setTimeout(() => {
          timer = undefined;
          fired = true;
          open({ x: at.x, y: at.y + SLOP });
        }, HOLD_MS);
      },
      onPointerMove: (event) => {
        if (
          origin !== undefined &&
          (Math.abs(event.clientX - origin.x) > SLOP ||
            Math.abs(event.clientY - origin.y) > SLOP)
        ) {
          stop();
        }
      },
      onPointerUp: stop,
      onPointerCancel: stop,
    },
  };
}
