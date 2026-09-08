import { createSignal, onCleanup } from "solid-js";

/** `md`, the one breakpoint that decides drawer or column. */
export const DESKTOP = "(min-width: 48rem)";

/** A precise, hovering pointer — the closest a browser comes to "is there a physical keyboard?". */
export const KEYBOARD = "(hover: hover) and (pointer: fine)";

/** A media query as a signal, `true` where there is no media engine. */
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
