import { keepFocus } from "../input/Composer";
import type { Reader } from "./reader";

const BUTTON =
  "flex items-center px-2.5 py-1 text-neutral-300 disabled:text-neutral-700 md:enabled:hover:bg-neutral-800 md:enabled:hover:text-neutral-50";

export function Jumps(props: { readonly reader: Reader }) {
  return (
    <div
      role="group"
      aria-label="Jump between messages"
      class="pointer-events-auto flex items-center divide-x-1.5 divide-neutral-750 overflow-hidden rounded-lg bg-neutral-900 text-sm ring-1 ring-neutral-750"
    >
      <button
        type="button"
        aria-label="Previous message"
        title="Previous message (Alt+↑)"
        disabled={props.reader.atTop()}
        class={BUTTON}
        onMouseDown={keepFocus}
        onClick={() => {
          props.reader.up();
        }}
      >
        <span class="i-lucide-chevron-up block size-[1lh]" />
      </button>
      <button
        type="button"
        aria-label="Next message"
        title="Next message (Alt+↓)"
        disabled={props.reader.pinned()}
        class={BUTTON}
        onMouseDown={keepFocus}
        onClick={() => {
          props.reader.down();
        }}
      >
        <span class="i-lucide-chevron-down block size-[1lh]" />
      </button>
    </div>
  );
}
