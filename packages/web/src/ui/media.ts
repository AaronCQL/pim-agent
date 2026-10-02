import { createSignal, onCleanup } from "solid-js";

/** `md`: sidebar is a column above it, a drawer below. */
export const DESKTOP = "(min-width: 48rem)";

/** Best proxy for a physical keyboard. */
export const KEYBOARD = "(hover: hover) and (pointer: fine)";

/** `true` without `matchMedia`. */
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
