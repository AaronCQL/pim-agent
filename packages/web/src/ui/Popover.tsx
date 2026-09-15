import { createEffect, createSignal, type Element } from "solid-js";
import type { JSX } from "@solidjs/web/jsx-runtime";

const GAP = 4;
const EDGE = 8;

/** Where in the viewport a gesture asked for a panel. */
export type Point = { readonly x: number; readonly y: number };

/** What the panel is measured against: the trigger's box, or the pointer that summoned it. */
function box(trigger: HTMLElement, at: Point | undefined): DOMRect {
  return at === undefined
    ? trigger.getBoundingClientRect()
    : new DOMRect(at.x, at.y, 0, 0);
}

/** Whether the side asked for keeps the panel: it holds the rows, or it is the roomier of the two. */
function keeps(room: number, other: number, needed: number): boolean {
  return room >= needed || room >= other;
}

/** A non-modal top-layer overlay; placement is measured in script and must write all four insets, or the UA's `[popover] { inset: 0 }` stretches it. */
export function Popover(props: {
  readonly open: boolean;
  readonly anchor: () => HTMLElement;
  readonly at?: () => Point | undefined;
  /** Cap the panel at the trigger's width instead of the room left on screen. */
  readonly match?: boolean;
  /** A floor for the panel's width, in px, where the trigger is far narrower than the rows it opens; the viewport still wins. */
  readonly min?: number;
  /** Which side of the trigger the panel takes; above it by default, as the composer's chips sit at the foot of the page. */
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
    // The height the rows want, read off the content rather than the box an
    // earlier cap has already squashed. A menu summoned by a finger near the
    // foot of the screen is otherwise a sliver of a list.
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
    // Read the trigger here: a prop read from a scroll or resize handler is subscribed to nothing.
    () => ({ open: props.open, trigger: props.anchor(), at: props.at?.() }),
    ({ open, trigger, at }) => {
      try {
        // Optional call: absent on engines without the attribute and in the test DOM.
        if (open) {
          host.showPopover?.();
        } else {
          host.hidePopover?.();
        }
      } catch {
        // Toggling to the state it is already in throws.
      }
      if (!open) {
        return;
      }
      // After the show, so the panel is laid out and can be measured.
      place(trigger, at);
      const reflow = (): void => {
        place(trigger, at);
      };
      // Again once the flush is over: the `hidden` class comes off in this
      // same flush but after this effect, so the height measured just now was
      // a `display: none` box's. A microtask still lands before the paint.
      queueMicrotask(reflow);
      // Scroll in the capture phase: the transcript that moves the composer scrolls itself, not the window.
      window.addEventListener("resize", reflow);
      window.addEventListener("scroll", reflow, true);
      const observer = new ResizeObserver(reflow);
      observer.observe(trigger);
      // Return the cleanup: an effect callback is not an owner, so `onCleanup` here would never run.
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
