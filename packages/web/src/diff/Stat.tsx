import { Show } from "solid-js";

/** `+12/−3`; a zero side is omitted along with the slash. */
export function Stat(props: {
  readonly added: number;
  readonly removed: number;
}) {
  return (
    <span class="flex shrink-0 items-center text-sm tabular-nums">
      <Show when={props.added > 0}>
        <span class="text-emerald-400">+{props.added}</span>
      </Show>
      <Show when={props.added > 0 && props.removed > 0}>
        <span class="text-neutral-600">/</span>
      </Show>
      <Show when={props.removed > 0}>
        <span class="text-rose-400">−{props.removed}</span>
      </Show>
    </span>
  );
}
