import { createMemo, Show } from "solid-js";

import { Format, type ContextFill } from "#core/shared/Format";
import type { SessionStore } from "../session/SessionStore";

const CONTEXT_TONES: Record<ContextFill, string> = {
  ok: "text-neutral-350",
  warn: "text-amber-400",
  full: "text-rose-400",
};

/** What the session has spent and how full its context is. */
export function Readouts(props: { readonly store: SessionStore }) {
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
