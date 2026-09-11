import { createSignal, onCleanup } from "solid-js";

/** `md`, the one breakpoint that decides drawer or column. */
export const DESKTOP = "(min-width: 48rem)";

/**
 * A pointer that is precise and hovers — a mouse, a trackpad, a stylus — which
 * is the closest a browser comes to answering "is there a physical keyboard?".
 * Asked instead of the width because the two disagree exactly where it
 * matters: a narrow desktop window still has Shift, and a landscape tablet
 * still has none.
 */
export const KEYBOARD = "(hover: hover) and (pointer: fine)";

/**
 * A media query as a signal. Not persisted and not a preference — it is what
 * the device currently is, which is why resizing a desktop window narrow
 * hands the sidebar to the drawer without a reload.
 *
 * Every query here is phrased so that the roomier, keyboard-having answer is
 * the `true` one: a DOM with no media engine reports nothing, and the desktop
 * behaviour is the safer thing to fall back to.
 */
export function createMediaQuery(query: string): () => boolean {
  const list = globalThis.matchMedia?.(query);
  const [matches, setMatches] = createSignal(list?.matches ?? true);
  if (list) {
    const onChange = (event: MediaQueryListEvent): void => {
      setMatches(event.matches);
    };
    list.addEventListener("change", onChange);
    onCleanup(() => {
      list.removeEventListener("change", onChange);
    });
  }
  return matches;
}
