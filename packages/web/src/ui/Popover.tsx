import { createEffect, createSignal, type Element } from "solid-js";
import type { JSX } from "@solidjs/web/jsx-runtime";

const GAP = 4;
const EDGE = 8;

/** Viewport coordinates. */
export type Point = { readonly x: number; readonly y: number };

function box(trigger: HTMLElement, at: Point | undefined): DOMRect {
  return at === undefined
    ? trigger.getBoundingClientRect()
    : new DOMRect(at.x, at.y, 0, 0);
}

/** Keep the preferred side if it fits the content or is the roomier one. */
function keeps(room: number, other: number, needed: number): boolean {
  return room >= needed || room >= other;
}

/** Placement must set all four insets, or the UA's `[popover] { inset: 0 }` stretches it. */
export function Popover(props: {
  readonly open: boolean;
  readonly anchor: () => HTMLElement;
  readonly at?: () => Point | undefined;
  /** Cap the width at the trigger's. */
  readonly match?: boolean;
  /** Minimum width in px; the viewport still wins. */
  readonly min?: number;
  /** Defaults to "above". */
  readonly place?: "above" | "below";
  readonly class?: string;
  readonly children: Element;
}) {
  const [placement, setPlacement] = createSignal<JSX.CSSProperties>({
    position: "absolute",
  });
  let host!: HTMLDivElement;

  const place = (trigger: HTMLElement, at: Point | undefined): void => {
    const rect = box(trigger, at);
    const width = Math.min(
      Math.max(rect.width, props.min ?? 0),
      window.innerWidth - 2 * EDGE
    );
    const left = Math.max(
      EDGE,
      Math.min(rect.left, window.innerWidth - EDGE - width)
    );
    const above = rect.top - EDGE - GAP;
    const under = window.innerHeight - rect.bottom - EDGE - GAP;
    // `scrollHeight`, not the box: an earlier max-height may have squashed it.
    const needed = host.scrollHeight;
    const below =
      props.place === "below"
        ? keeps(under, above, needed)
        : !keeps(above, under, needed);
    setPlacement({
      position: "fixed",
      top: below ? `${rect.bottom + GAP}px` : "auto",
      right: "auto",
      left: `${left}px`,
      bottom: below ? "auto" : `${window.innerHeight - rect.top + GAP}px`,
      "min-width": `${width}px`,
      "max-width": `${props.match ? rect.width : window.innerWidth - EDGE - left}px`,
      "max-height": `${Math.max(below ? under : above, 0)}px`,
      margin: "0",
    });
  };

  createEffect(
    // Read props here: reads from the scroll/resize handlers are untracked.
    () => ({ open: props.open, trigger: props.anchor(), at: props.at?.() }),
    ({ open, trigger, at }) => {
      try {
        // Absent in some engines and in the test DOM.
        if (open) {
          host.showPopover?.();
        } else {
          host.hidePopover?.();
        }
      } catch {
        // Throws when already in that state.
      }
      if (!open) {
        return;
      }
      place(trigger, at);
      const reflow = (): void => {
        place(trigger, at);
      };
      // Again after the flush: `hidden` is removed later in it, so the first measure saw `display: none`.
      queueMicrotask(reflow);
      // Capture phase: inner scrollers do not bubble scroll to the window.
      window.addEventListener("resize", reflow);
      window.addEventListener("scroll", reflow, true);
      const observer = new ResizeObserver(reflow);
      observer.observe(trigger);
      // `onCleanup` would never run here: an effect callback is not an owner.
      return () => {
        window.removeEventListener("resize", reflow);
        window.removeEventListener("scroll", reflow, true);
        observer.disconnect();
      };
    }
  );

  return (
    <div
      ref={(element: HTMLDivElement) => {
        host = element;
      }}
      popover="manual"
      class={{
        [props.class ?? ""]: props.class !== undefined,
        hidden: !props.open,
      }}
      style={placement()}
    >
      {props.children}
    </div>
  );
}
