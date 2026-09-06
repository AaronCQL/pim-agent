import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";

import { Format } from "#core/shared/Format";
import type { DurableEvent } from "#protocol/ServerEvent";
import type { SessionStore } from "../session/SessionStore";
import { Spinner } from "../ui/Spinner";

/**
 * The one running indicator: a pill above the composer's left edge, inline
 * with the cost and context pill on its right and drawn in the same style.
 * The agent status word, tok/s and the `seq` readout are gone with the
 * footer; this is what replaced them, and it says exactly what the TUI's
 * working indicator says.
 *
 * The leading mark carries the state on its own — a spinning three-quarter
 * ring while the turn runs, a tick once it has settled — so the words are
 * free to go when there is no room for them, which on a phone there is not.
 *
 * The running clock is client-side: it starts when the status leaves `idle`,
 * so nothing about a live turn has to travel on the wire. A client that was
 * not watching — a reload, a phone that woke up — reads the settled figure off
 * the durable log instead, as last user message → last assistant message.
 * Neither needs `turn_end` to be persisted, which is why it never is.
 */
export function ClankChip(props: { readonly store: SessionStore }) {
  const [elapsed, setElapsed] = createSignal<number | undefined>(undefined);
  const replayed = createMemo(() => lastTurnMs(props.store.state.durable));
  const shown = createMemo(() => elapsed() ?? replayed());
  const words = createMemo(() =>
    props.store.isBusy() ? "Clanking…" : "Clanked for"
  );
  const reading = createMemo(() => Format.formatElapsed(shown() ?? 0));
  let timer: ReturnType<typeof setInterval> | undefined;
  let startedAt = 0;
  onCleanup(() => {
    clearInterval(timer);
  });

  createEffect(
    () => props.store.isBusy(),
    (busy) => {
      const measure = (): void => {
        setElapsed(Date.now() - startedAt);
      };
      // Both arms turn on the edge, not on the run: the agent status moves
      // between `thinking`, `streaming` and `tool` for the whole turn, and
      // an effect re-runs on each of those — the boolean it computes being
      // unchanged does not stop it. Reading the clock on every run would
      // restart it at each tool call and each block of prose, and re-reading
      // it while idle would keep growing a turn that has already ended.
      const ticking = timer !== undefined;
      if (busy === ticking) {
        return;
      }
      if (busy) {
        startedAt = Date.now();
        measure();
        timer = setInterval(measure, 1000);
        return;
      }
      clearInterval(timer);
      timer = undefined;
      measure();
    }
  );

  return (
    // Tested against `undefined`, not for truth: a turn one tick old measures
    // zero, and zero is a reading rather than an absence.
    <Show when={shown() !== undefined}>
      <div
        // `pointer-events-auto` against the row's `none`: the words are
        // dropped on a narrow viewport, and a narrow *desktop* window still
        // has a pointer to put on the title.
        class="pointer-events-auto flex items-center gap-1.5 rounded-lg bg-neutral-900 px-2.5 py-1 text-sm text-neutral-350 tabular-nums ring-1 ring-neutral-750"
        // The mark and the reading are all a narrow screen gets, so the
        // words it drops have to survive on hover and to a screen reader.
        title={`${words()} ${reading()}`}
        aria-label={`${words()} ${reading()}`}
      >
        <Show
          when={props.store.isBusy()}
          fallback={
            <span
              class="i-griddy-icons:check size-3.5 shrink-0"
              aria-hidden="true"
            />
          }
        >
          <Spinner />
        </Show>
        <span class="hidden sm:inline">{words()}</span>
        <span>{reading()}</span>
      </div>
    </Show>
  );
}

/**
 * The last completed turn's wall time. Bounded by the last assistant message
 * rather than the end of the log, so tool results appended after it — which
 * carry the same stamps — cannot stretch the reading.
 */
function lastTurnMs(events: readonly DurableEvent[]): number | undefined {
  let assistantAt: number | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "message") {
      continue;
    }
    if (event.role === "assistant") {
      assistantAt ??= event.timestamp;
      continue;
    }
    if (assistantAt === undefined) {
      return undefined;
    }
    const ms = assistantAt - event.timestamp;
    return ms > 0 ? ms : undefined;
  }
  return undefined;
}
