import { onCleanup } from "solid-js";

/** How far off the end still counts as reading the end, in pixels. */
const SLACK = 40;

/**
 * A scroller that follows content growing at its end, and stops following the
 * moment its reader scrolls away from that end.
 *
 * The client owns scroll anchoring, as it owns draft state and collapse — the
 * server has no opinion about any of it. One implementation, used by every
 * transcript on screen: the conversation and the modal a subagent is read in
 * grow the same way, and two schemes would drift.
 */
export type ScrollAnchor = {
  /** Ref for the scrolling element. */
  readonly mount: (element: HTMLElement) => void;
  readonly onScroll: () => void;
  /** The content grew: follow it if the reader is still at the end. */
  readonly stick: () => void;
  /** "I am reading the end again", for a gesture that says so. */
  readonly jump: () => void;
  /**
   * Something above or below the transcript changed height by `delta`, so the
   * last line is held where it was relative to it.
   */
  readonly shift: (delta: number) => void;
};

export function createScrollAnchor(): ScrollAnchor {
  let scroller: HTMLElement | undefined;
  let pinned = true;
  // Where the transcript was last left, by the reader or by this anchor. A
  // scroll event says a position changed, never who changed it, and the two
  // are told apart by direction: only a reader moves the end away.
  let anchor = 0;

  // Every write to `scrollTop` goes through here, because the anchor has to
  // move with it: the browser clamps the value it is given and reports the
  // move one frame later, and an anchor left behind would make that late
  // report look like a reader's gesture.
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
      // Slack alone cannot answer this. A row is taller than the flush that
      // appended it — markdown parses, code blocks grow a copy button, images
      // arrive — and a scroll event is delivered a frame after the position it
      // reports was written, so the scroll this anchor itself wrote to reach
      // the end is read back against a transcript that has since grown past
      // it. Read as slack, that is indistinguishable from the reader having
      // scrolled up, and unpinning there strands the transcript a screenful
      // short of its end for good: the observer that would have caught the
      // growth is now told to leave it alone.
      //
      // So the end is left only by moving away from it, which only a reader
      // does, and reaching it re-pins however it was reached.
      if (slack < SLACK) {
        pinned = true;
      } else if (top < anchor) {
        pinned = false;
      }
      anchor = top;
    },
  };
}

/**
 * An element's own height, reported as it changes.
 *
 * A `ResizeObserver` rather than a keystroke handler because the things that
 * push a transcript around have several ways to change height that are not
 * typing — a wrapped model name, an attachment row, the error line, a window
 * resize — and a border-box measurement catches every one of them at the
 * moment layout settles.
 *
 * A DOM with no layout engine — the one the tests run in — reports zero
 * forever, which is the right answer there: nothing overlaps anything.
 */
export function observeHeight(
  element: HTMLElement,
  report: (height: number) => void
): void {
  const observer = new ResizeObserver(() => {
    report(element.offsetHeight);
  });
  observer.observe(element);
  onCleanup(() => {
    observer.disconnect();
  });
}
