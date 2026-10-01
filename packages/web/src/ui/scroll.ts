import {
  createEffect,
  createSignal,
  getOwner,
  onCleanup,
  runWithOwner,
  type Accessor,
} from "solid-js";

/** Distance from the bottom, in px, that still counts as pinned. */
const BOTTOM_SLACK = 16;

function observe(
  measure: (element: HTMLElement) => number,
  report: (value: number) => void
): (element: HTMLElement) => void {
  const owner = getOwner();
  return (element) => {
    const observer = new ResizeObserver(() => {
      report(measure(element));
    });
    observer.observe(element);
    runWithOwner(owner, () => {
      onCleanup(() => {
        observer.disconnect();
      });
    });
  };
}

/** Call during component setup, not inside a `ref`: it needs an owner for cleanup. */
export function observeHeight(
  report: (height: number) => void
): (element: HTMLElement) => void {
  return observe((element) => element.offsetHeight, report);
}

/** Same rules as `observeHeight`. */
export function observeWidth(
  report: (width: number) => void
): (element: HTMLElement) => void {
  return observe((element) => element.offsetWidth, report);
}

/** Scrolls the `[data-index]` row matching `index` into view while open. */
export function followActive(
  list: () => HTMLElement | undefined,
  index: () => number,
  open: () => boolean
): void {
  createEffect(
    () => ({ index: index(), open: open() }),
    ({ index: active, open: shown }) => {
      if (!shown) {
        return;
      }
      list()
        ?.querySelector(`[data-index="${active}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }
  );
}

export type BottomPin = {
  readonly pinned: Accessor<boolean>;
  readonly ref: (element: HTMLElement) => void;
  readonly jump: () => void;
};

/**
 * Follow state of a `flex-col-reverse` scroller (`scrollTop` 0 is the bottom).
 * Callers disable scroll anchoring while pinned and keep it while scrolled up.
 */
export function createBottomPin(): BottomPin {
  const owner = getOwner();
  const [pinned, setPinned] = createSignal(true);
  let scroller: HTMLElement | undefined;

  return {
    pinned,
    ref: (element: HTMLElement) => {
      scroller = element;
      const sync = (): void => {
        setPinned(element.scrollTop >= -BOTTOM_SLACK);
      };
      element.addEventListener("scroll", sync, { passive: true });
      // Writes are not allowed inside a `ref`.
      queueMicrotask(sync);
      runWithOwner(owner, () => {
        onCleanup(() => {
          element.removeEventListener("scroll", sync);
        });
      });
    },
    jump: () => {
      if (scroller) {
        scroller.scrollTop = 0;
      }
      setPinned(true);
    },
  };
}
