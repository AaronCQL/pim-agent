import { Show } from "solid-js";

/**
 * `+12/−3`, the stat a diff tool's own title carries: the slash binds the two
 * counts into one reading, so neither is mistaken for a number belonging to
 * something else on the bar. A side that never happened is left out — a
 * trailing `/` would promise a removal.
 */
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
