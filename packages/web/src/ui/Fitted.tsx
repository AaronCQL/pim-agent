import type { JSX } from "@solidjs/web/jsx-runtime";
import { createSignal, onCleanup } from "solid-js";

import { fit } from "../format";

// Sub-pixel slack, so a text that just fits is not elided.
const SLACK = 0.02;

/** Shows the first of `texts` that fits; `children` gets the room in columns instead. */
export function Fitted(props: {
  readonly texts: readonly string[];
  readonly class?: string;
  readonly children?: (columns: number) => JSX.Element;
}) {
  const [share, setShare] = createSignal(1);
  const widest = (): string => props.texts[0] ?? "";
  const columns = (): number => Math.floor(widest().length * share() + SLACK);

  let box!: HTMLSpanElement;
  // Unclipped copy to measure: the box itself shrinks onto its ellipsis.
  // `inline-block` because inline boxes are not observed.
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
