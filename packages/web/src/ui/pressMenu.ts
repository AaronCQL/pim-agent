import type { JSX } from "@solidjs/web/jsx-runtime";
import { onCleanup } from "solid-js";

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

/** The two ways a pointer asks a row for its verbs: a right-click, and a finger held still. */
export function createPressMenu(open: () => void): PressMenu {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let origin: { readonly x: number; readonly y: number } | undefined;
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
        open();
      },
      onPointerDown: (event) => {
        fired = false;
        if (event.pointerType === "mouse") {
          return;
        }
        origin = { x: event.clientX, y: event.clientY };
        timer = setTimeout(() => {
          timer = undefined;
          fired = true;
          open();
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
