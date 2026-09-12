import type { JSX } from "@solidjs/web/jsx-runtime";
import { createSignal, onCleanup } from "solid-js";

import { fit } from "../format";

// Sub-pixel slack, or a box a hair under its own text elides a text that fits.
const SLACK = 0.02;

/**
 * The first of `texts` the box has room for, measured rather than guessed.
 * A child paints the room itself, in character cells, when what fits is more
 * than one string — the count is what it was measured in either way.
 */
export function Fitted(props: {
  readonly texts: readonly string[];
  readonly class?: string;
  readonly children?: (columns: number) => JSX.Element;
}) {
  const [share, setShare] = createSignal(1);
  const widest = (): string => props.texts[0] ?? "";
  const columns = (): number => Math.floor(widest().length * share() + SLACK);

  let box!: HTMLSpanElement;
  let ghost!: HTMLSpanElement;
  const observer = new ResizeObserver(() => {
    const full = ghost.getBoundingClientRect().width;
    setShare(full > 0 ? box.getBoundingClientRect().width / full : 1);
  });
  onCleanup(() => {
    observer.disconnect();
  });

  return (
    <span
      ref={(element: HTMLSpanElement) => {
        box = element;
        observer.observe(element);
      }}
      class={`relative min-w-0 overflow-hidden whitespace-pre ${props.class ?? ""}`}
    >
      {/* The chip is `max-w-max`, so measure a copy no cut touches, or the box
          shrinks onto its own ellipsis. `inline-block`: inline boxes go unobserved. */}
      <span
        ref={(element: HTMLSpanElement) => {
          ghost = element;
          observer.observe(element);
        }}
        aria-hidden="true"
        class="invisible inline-block"
      >
        {widest()}
      </span>
      <span class="absolute inset-0">
        {props.children === undefined
          ? fit(props.texts, columns())
          : props.children(columns())}
      </span>
    </span>
  );
}
