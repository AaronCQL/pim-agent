import type { JSX } from "@solidjs/web/jsx-runtime";
import { onCleanup } from "solid-js";

import type { Point } from "./Popover";

const HOLD_MS = 450;

/** Movement in px that cancels a long press. */
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
  readonly handlers: Handlers;
  /** True once if the last press opened the menu, so the caller can skip its tap. */
  readonly swallowed: () => boolean;
};

/** Opens a menu at the pointer on right-click or long press. */
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
