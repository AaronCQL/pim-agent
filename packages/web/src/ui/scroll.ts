import { getOwner, onCleanup, runWithOwner } from "solid-js";

const SLACK = 40;

/** A scroller that follows content growing at its end, until its reader scrolls away from that end. */
export type ScrollAnchor = {
  readonly mount: (element: HTMLElement) => void;
  readonly onScroll: () => void;
  readonly stick: () => void;
  readonly jump: () => void;
  readonly shift: (delta: number) => void;
};

export function createScrollAnchor(): ScrollAnchor {
  let scroller: HTMLElement | undefined;
  let pinned = true;
  let anchor = 0;

  // Route every `scrollTop` write through here: the browser clamps it and reports the move a frame later, and a stale anchor reads back as a reader's gesture.
  const scrollTo = (top: number): void => {
    if (!scroller) {
      return;
    }
    scroller.scrollTop = top;
    anchor = scroller.scrollTop;
  };

  const stick = (): void => {
    if (pinned && scroller) {
      scrollTo(scroller.scrollHeight);
    }
  };

  return {
    mount: (element) => {
      scroller = element;
    },
    stick,
    jump: () => {
      pinned = true;
      stick();
    },
    shift: (delta) => {
      if (pinned || !scroller) {
        stick();
        return;
      }
      scrollTo(scroller.scrollTop + delta);
    },
    onScroll: () => {
      if (!scroller) {
        return;
      }
      const top = scroller.scrollTop;
      const slack = scroller.scrollHeight - top - scroller.clientHeight;
      // Unpin only on moving away from the end: rows grow after the flush that appended them, so slack alone reads a self-written scroll as a reader's.
      if (slack < SLACK) {
        pinned = true;
      } else if (top < anchor) {
        pinned = false;
      }
      anchor = top;
    },
  };
}

/** A `ref` reporting an element's height; call it during setup, not inside a `ref`, where there is no owner to run its cleanup. */
export function observeHeight(
  report: (height: number) => void
): (element: HTMLElement) => void {
  const owner = getOwner();
  return (element) => {
    const observer = new ResizeObserver(() => {
      report(element.offsetHeight);
    });
    observer.observe(element);
    runWithOwner(owner, () => {
      onCleanup(() => {
        observer.disconnect();
      });
    });
  };
}
