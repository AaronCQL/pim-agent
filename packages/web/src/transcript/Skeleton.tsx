import { For } from "solid-js";

/**
 * What stands in for a conversation that has been asked for and not arrived.
 *
 * Shaped like the transcript it replaces — a right-aligned card, then prose,
 * then a run of tool lines — so the swap moves nothing the eye was already
 * tracking. Deliberately not a spinner: the wait is short, and a spinner in
 * the middle of an empty page reads as "something is wrong" where a greyed-out
 * conversation reads as "your conversation, in a moment".
 */
export function Skeleton() {
  const widths = ["60%", "95%", "85%", "70%"];

  return (
    <div class="animate-pulse space-y-[--line]" aria-hidden="true">
      <div class="flex justify-end">
        <div class="h-[calc(var(--line)*2)] w-2/5 rounded-lg bg-neutral-850" />
      </div>

      <div class="space-y-2">
        <For each={widths}>
          {(width) => (
            <div class="h-[--line] rounded bg-neutral-850" style={{ width }} />
          )}
        </For>
      </div>

      <div>
        <For each={[0, 1, 2]}>
          {() => (
            <div class="flex h-[--line] items-center gap-2">
              <div class="size-3 rounded bg-neutral-850" />
              <div class="h-3 w-1/3 rounded bg-neutral-850" />
            </div>
          )}
        </For>
      </div>

      <div class="flex justify-end">
        <div class="h-[--line] w-1/4 rounded-lg bg-neutral-850" />
      </div>
    </div>
  );
}
