import { getOwner, onCleanup, runWithOwner } from "solid-js";

/** Travel in px before a touch commits to an axis. */
const SLOP = 10;

/** Travel in px along the swipe that completes it. */
const REACH = 48;

export type SwipeDirection = "left" | "right";

type Point = { readonly x: number; readonly y: number };

function scrollsBack(element: Element, toward: SwipeDirection): boolean {
  if (!/auto|scroll/.test(getComputedStyle(element).overflowX)) {
    return false;
  }
  return toward === "right"
    ? element.scrollLeft > 0
    : element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
}

/** A touch the swipe must leave alone: on a layer stacked inside `host`, or on content that would scroll instead. */
function claimed(
  target: EventTarget | null,
  host: HTMLElement,
  toward: SwipeDirection
): boolean {
  if (!(target instanceof Element)) {
    return true;
  }
  const layer = target.closest("dialog, [popover]");
  if (layer !== null && layer !== host && host.contains(layer)) {
    return true;
  }
  for (
    let element: Element | null = target;
    element !== null && element !== host;
    element = element.parentElement
  ) {
    if (scrollsBack(element, toward)) {
      return true;
    }
  }
  return false;
}

/** A one-finger horizontal swipe across the element. Call during component setup, not inside a `ref`. */
export function createSwipe(
  toward: SwipeDirection,
  onSwipe: () => void
): (element: HTMLElement) => void {
  const owner = getOwner();
  const sign = toward === "right" ? 1 : -1;

  return (host) => {
    let origin: Point | undefined;
    let locked = false;

    const reset = (): void => {
      origin = undefined;
      locked = false;
    };

    const start = (event: TouchEvent): void => {
      reset();
      const touch = event.touches[0];
      if (
        event.touches.length !== 1 ||
        touch === undefined ||
        claimed(event.target, host, toward)
      ) {
        return;
      }
      origin = { x: touch.clientX, y: touch.clientY };
    };

    const move = (event: TouchEvent): void => {
      const touch = event.touches[0];
      if (origin === undefined || touch === undefined) {
        return;
      }
      const along = (touch.clientX - origin.x) * sign;
      const across = Math.abs(touch.clientY - origin.y);
      if (!locked) {
        if (Math.max(Math.abs(along), across) < SLOP) {
          return;
        }
        if (along <= across) {
          reset();
          return;
        }
        locked = true;
      }
      if (along >= REACH) {
        reset();
        onSwipe();
      }
    };

    host.addEventListener("touchstart", start, { passive: true });
    host.addEventListener("touchmove", move, { passive: true });
    host.addEventListener("touchend", reset);
    host.addEventListener("touchcancel", reset);
    runWithOwner(owner, () => {
      onCleanup(() => {
        host.removeEventListener("touchstart", start);
        host.removeEventListener("touchmove", move);
        host.removeEventListener("touchend", reset);
        host.removeEventListener("touchcancel", reset);
      });
    });
  };
}
