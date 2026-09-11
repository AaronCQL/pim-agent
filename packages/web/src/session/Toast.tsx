import { Show } from "solid-js";

import type { Reload } from "./Reload";

/** What the app has to say about itself, over the transcript rather than in it. */
export function Toast(props: {
  readonly update: Reload;
  readonly desktop: boolean;
}) {
  const state = () => props.update.state;
  return (
    <Show
      when={
        !state().dismissed && (state().pending || state().notice !== undefined)
      }
    >
      <div
        role="status"
        class={{
          "absolute top-3 z-50 rounded-lg bg-neutral-850 px-3 py-[calc(var(--line)/2)] text-sm shadow-lg ring-1 ring-neutral-700": true,
          "right-3 max-w-sm": props.desktop,
          "inset-x-3": !props.desktop,
          "text-amber-400": state().notice?.tone === "warning",
          "text-rose-400": state().notice?.tone === "error",
        }}
      >
        <button
          type="button"
          aria-label="Dismiss notification"
          class="float-right -mt-px ml-2 flex size-6 items-center justify-center rounded-md text-neutral-350 hover:bg-neutral-800 hover:text-neutral-50"
          onClick={() => props.update.dismiss()}
        >
          <span class="i-griddy-icons:close size-4" aria-hidden="true" />
        </button>
        <span class="whitespace-pre-wrap">
          {state().pending ? state().label : state().notice?.text}
        </span>
      </div>
    </Show>
  );
}
