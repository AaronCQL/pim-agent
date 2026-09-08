import { createEffect, createSignal, type Element } from "solid-js";
import type { JSX } from "@solidjs/web/jsx-runtime";

/** Breathing room between the panel and its trigger, and the viewport edge. */
const GAP = 4;
const EDGE = 8;

/**
 * The only wrapper feature code may use for an overlay that is not modal.
 *
 * The platform primitive is the `popover` attribute: it promotes the element
 * to the top layer, so a picker anchored to an input is never clipped by an
 * ancestor's `overflow`, and it brings ESC with it. That is the whole reason
 * no headless component library is installed.
 *
 * `manual` rather than `auto` because the picker's lifetime is owned by the
 * composer's token state: a light-dismiss that closed it behind the composer's
 * back would leave the two disagreeing. Dismissal is routed through the
 * caller instead.
 *
 * Placement, however, is measured here rather than declared in CSS. The top
 * layer's containing block is the viewport, so a promoted panel has left the
 * trigger's coordinate space behind: something has to put it back. CSS anchor
 * positioning is that something only where it is implemented — where it is
 * not, every `anchor()` inset is invalid and the panel falls back to the UA's
 * `[popover] { inset: 0 }`, which is why every picker used to open at the top
 * of the screen. One measured path is one behaviour on every engine.
 *
 * That UA rule is also why all four insets are written on every placement,
 * `auto` included: setting `bottom` alone leaves `top: 0` standing, and a box
 * with both is stretched from the top of the screen down — the same wrong
 * picture as no positioning at all.
 */
export function Popover(props: {
  readonly open: boolean;
  /** The element the panel is placed over — the chip, or the composer card. */
  readonly anchor: () => HTMLElement;
  /**
   * Cap the panel at the trigger's width instead of the room left on screen.
   * A chip wants the opposite — a two-word trigger cannot say how wide a list
   * of model names is — but a panel over the composer card is reading as part
   * of the card, and a completion list wider than the box it completes is a
   * second, disagreeing edge down the middle of the page. Paired with the
   * `min-width` below it pins the panel to exactly the trigger's width, which
   * leaves the rows to truncate.
   */
  readonly match?: boolean;
  readonly class?: string;
  readonly children: Element;
}) {
  const [placement, setPlacement] = createSignal<JSX.CSSProperties>({
    position: "absolute",
  });
  let host!: HTMLDivElement;

  /**
   * Above the trigger, left edges flush. Always above, never flipped: every
   * trigger there is lives on the composer, which is pinned to the bottom of
   * the window, so "below" is a strip of padding the panel would never fit
   * in. The panel grows upward from the trigger and stops at the top edge of
   * the viewport, and `left` is clamped so a trigger near the right edge
   * pulls its panel back into view rather than off it.
   */
  const place = (trigger: HTMLElement): void => {
    const rect = trigger.getBoundingClientRect();
    const left = Math.max(
      EDGE,
      // The trigger's own width, not the panel's measured one: the panel is
      // at least that wide and `max-width` keeps whatever it adds on screen,
      // so the alignment does not depend on how long a filename is.
      Math.min(rect.left, window.innerWidth - EDGE - rect.width)
    );
    setPlacement({
      position: "fixed",
      top: "auto",
      right: "auto",
      left: `${left}px`,
      bottom: `${window.innerHeight - rect.top + GAP}px`,
      "min-width": `${rect.width}px`,
      "max-width": `${props.match ? rect.width : window.innerWidth - EDGE - left}px`,
      "max-height": `${Math.max(rect.top - EDGE - GAP, 0)}px`,
      margin: "0",
    });
  };

  createEffect(
    // The trigger is read here rather than at placement time: measuring is
    // imperative work driven by scrolls and resizes, and a prop read from one
    // of those is a read nothing is subscribed to — the panel would go on
    // measuring an element the caller had already replaced.
    () => ({ open: props.open, trigger: props.anchor() }),
    ({ open, trigger }) => {
      try {
        // Absent on engines without the attribute, and on the DOM the tests
        // run in; those fall back to an ordinary positioned element, which
        // the measured placement already covers.
        if (open) {
          host.showPopover?.();
        } else {
          host.hidePopover?.();
        }
      } catch {
        // Toggling to the state it is already in throws; nothing to do.
      }
      if (!open) {
        return;
      }
      // After the show, so the panel has been laid out and can be measured.
      place(trigger);
      const reflow = (): void => {
        place(trigger);
      };
      // Scroll in the capture phase: the transcript that moves the composer
      // scrolls itself, not the window.
      window.addEventListener("resize", reflow);
      window.addEventListener("scroll", reflow, true);
      const observer = new ResizeObserver(reflow);
      observer.observe(trigger);
      // Returned rather than registered with `onCleanup`: an effect callback
      // is not an owner, so a cleanup asked for there is never run at all and
      // every open leaks its listeners and its observer.
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
