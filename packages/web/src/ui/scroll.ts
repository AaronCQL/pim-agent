import {
  createSignal,
  getOwner,
  onCleanup,
  runWithOwner,
  type Accessor,
} from "solid-js";

/** How near its bottom origin a scroller counts as following the newest content, in px. */
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

/** A `ref` reporting an element's height; call it during setup, not inside a `ref`, where there is no owner to run its cleanup. */
export function observeHeight(
  report: (height: number) => void
): (element: HTMLElement) => void {
  return observe((element) => element.offsetHeight, report);
}

/** A `ref` reporting an element's width, under the same rule as `observeHeight`. */
export function observeWidth(
  report: (width: number) => void
): (element: HTMLElement) => void {
  return observe((element) => element.offsetWidth, report);
}

export type BottomPin = {
  /** Following the newest content, rather than parked where the reader left off. */
  readonly pinned: Accessor<boolean>;
  readonly ref: (element: HTMLElement) => void;
  /** Back to the newest content, and following it again. */
  readonly jump: () => void;
};

/**
 * The follow state of a `flex-col-reverse` scroller, whose origin — `scrollTop`
 * zero — is its bottom edge.
 *
 * Pinned, the scroller opts out of scroll anchoring, and the reversed origin
 * holds it against content growing above it. Parked, anchoring earns its keep:
 * it holds the text the reader is on still while more streams in below. The
 * browser draws that same line at an offset of exactly zero, which a wheel or a
 * momentum scroll lands on only by luck; the slack draws it where a reader
 * would.
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
      // A scroller mounted in another's place starts at the origin, and says so
      // out of the `ref`, where a write is not allowed.
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
