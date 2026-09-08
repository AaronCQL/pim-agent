import { createMemo, Show } from "solid-js";

import { Format, type ContextFill } from "#core/shared/Format";
import type { SessionStore } from "../session/SessionStore";

/** The ramp's colour for each verdict `Format.contextFill` hands back. */
const CONTEXT_TONES: Record<ContextFill, string> = {
  ok: "text-neutral-350",
  warn: "text-amber-400",
  full: "text-rose-400",
};

/** What the session has spent and how full its context is. */
export function Readouts(props: { readonly store: SessionStore }) {
  // One memo, not a percentage read three times: a fill of 0 is a reading,
  // and an object keeps it from being mistaken for "no reading yet".
  const fill = createMemo(() => {
    const percent = props.store.state.contextPercent;
    return percent === undefined
      ? undefined
      : {
          text: `${percent.toFixed(1)}%`,
          tone: CONTEXT_TONES[Format.contextFill(percent)],
        };
  });

  return (
    /* The divided pill: spend on the left, context fill on the right,
       each half drawn only once there is something to say. */
    <Show when={props.store.state.cost > 0 || fill() !== undefined}>
      <div class="ml-auto flex items-center divide-x-1.5 divide-neutral-750 rounded-lg bg-neutral-900 text-sm text-neutral-350 tabular-nums ring-1 ring-neutral-750">
        <Show when={props.store.state.cost > 0}>
          <div class="px-2.5 py-1">{`$${props.store.state.cost.toFixed(3)}`}</div>
        </Show>
        <Show when={fill()}>
          {(shown) => (
            <div class={`px-2.5 py-1 ${shown().tone}`}>
              {shown().text}
              <Show when={props.store.state.contextWindow}>
                {(window) => (
                  <span class="text-neutral-500">
                    {`/${Format.formatTokens(window())}`}
                  </span>
                )}
              </Show>
            </div>
          )}
        </Show>
      </div>
    </Show>
  );
}
