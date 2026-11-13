import {
  createSignal,
  getOwner,
  onCleanup,
  runWithOwner,
  untrack,
  type Accessor,
} from "solid-js";

import { createBottomPin, type BottomPin } from "../ui/scroll";

/** How far below the scroller's top edge a stop lands. */
const MARGIN = 12;
/** A stop this close to the landing line is already on it. */
const SLACK = 4;
/** Take whichever reply is last at the next layout as seen. */
const ADOPT = Symbol("adopt");
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const GLIDE_MS = 180;
/** The reader scrolling by hand cancels a glide. */
const TAKEOVERS = ["wheel", "touchstart"] as const;

export type Reader = BottomPin & {
  readonly content: (element: HTMLElement) => void;
  readonly atTop: Accessor<boolean>;
  /** To the nearest `[data-stop]` above the landing line, else the very top; gliding unless motion is reduced. */
  readonly up: () => void;
  /** To the next `[data-stop]` below the landing line, else the bottom. */
  readonly down: () => void;
  /** A freshly loaded session: unread lands on its last reply, read stays at the bottom. */
  readonly open: (unread: boolean) => void;
};

/**
 * A `flex-col-reverse` transcript that follows the bottom, except that it never
 * carries the start of a reply it has not shown yet off the top: it holds there.
 */
export function createReader(inset: Accessor<number>): Reader {
  const owner = getOwner();
  let content: HTMLElement | undefined;
  let observer: ResizeObserver | undefined;
  let seen: string | undefined | typeof ADOPT = ADOPT;
  /** Where a glide is going; a step taken mid-glide counts from there. */
  let heading: number | undefined;
  let frame = 0;
  const arrive = (): void => {
    cancelAnimationFrame(frame);
    heading = undefined;
  };
  const [atTop, setAtTop] = createSignal(true);

  const lastReply = (): HTMLElement | undefined => {
    const replies = content?.querySelectorAll<HTMLElement>("[data-reply]");
    return replies?.[replies.length - 1];
  };
  const pin = createBottomPin(() => {
    seen = lastReply()?.dataset.reply;
  });
  const line = (scroller: HTMLElement): number =>
    scroller.getBoundingClientRect().top + MARGIN;
  const stops = (): number[] =>
    [...(content?.querySelectorAll("[data-stop]") ?? [])].map(
      (stop) => stop.getBoundingClientRect().top
    );

  const measure = (): void => {
    const scroller = pin.scroller();
    if (scroller) {
      setAtTop(
        scroller.scrollHeight - scroller.clientHeight + scroller.scrollTop <=
          SLACK
      );
    }
  };

  const step = (direction: "up" | "down"): void => {
    const scroller = pin.scroller();
    if (!scroller) {
      return;
    }
    const from = heading ?? scroller.scrollTop;
    const at = line(scroller) + from - scroller.scrollTop;
    const tops = stops();
    const stop =
      direction === "up"
        ? tops.findLast((top) => top < at - SLACK)
        : tops.find((top) => top > at + SLACK);
    const fallback = direction === "up" ? -Infinity : 0;
    const top = Math.min(
      0,
      Math.max(
        scroller.clientHeight - scroller.scrollHeight,
        stop === undefined ? fallback : from + stop - at
      )
    );
    if (globalThis.matchMedia(REDUCED_MOTION).matches) {
      pin.scrollBy(top - scroller.scrollTop);
      measure();
      return;
    }
    glide(scroller, top);
  };

  const glide = (scroller: HTMLElement, top: number): void => {
    cancelAnimationFrame(frame);
    heading = top;
    const start = scroller.scrollTop;
    const began = performance.now();
    const tick = (now: number): void => {
      const done = Math.min(1, Math.max(0, (now - began) / GLIDE_MS));
      scroller.scrollTop = start + (top - start) * (1 - (1 - done) ** 3);
      if (done < 1) {
        frame = requestAnimationFrame(tick);
      } else {
        heading = undefined;
      }
    };
    frame = requestAnimationFrame(tick);
  };

  const hold = (): void => {
    const lead = lastReply();
    if (seen === ADOPT) {
      seen = lead?.dataset.reply;
      return;
    }
    const scroller = pin.scroller();
    if (
      !lead ||
      !scroller ||
      !untrack(pin.pinned) ||
      lead.dataset.reply === seen ||
      lead.offsetHeight <= scroller.clientHeight - untrack(inset) - MARGIN
    ) {
      return;
    }
    seen = lead.dataset.reply;
    pin.scrollBy(lead.getBoundingClientRect().top - line(scroller));
  };

  return {
    ...pin,
    atTop,
    ref: (element) => {
      pin.ref(element);
      element.addEventListener("scroll", measure, { passive: true });
      for (const type of TAKEOVERS) {
        element.addEventListener(type, arrive, { passive: true });
      }
      runWithOwner(owner, () => {
        onCleanup(() => {
          element.removeEventListener("scroll", measure);
          for (const type of TAKEOVERS) {
            element.removeEventListener(type, arrive);
          }
        });
      });
    },
    content: (element) => {
      content = element;
      observer?.disconnect();
      const next = new ResizeObserver(() => {
        hold();
        measure();
      });
      observer = next;
      next.observe(element);
      runWithOwner(owner, () => {
        onCleanup(() => {
          next.disconnect();
        });
      });
    },
    up: () => {
      step("up");
    },
    down: () => {
      step("down");
    },
    open: (unread) => {
      seen = unread ? undefined : ADOPT;
    },
  };
}
