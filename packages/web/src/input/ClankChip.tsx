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

const TURN_SLACK_MS = 2_000;

/** The running indicator: a spinner and the turn's elapsed time, anchored to the server's `turnElapsedMs`. */
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
  let timing = "";
  const stop = (): void => {
    clearInterval(timer);
    timer = undefined;
  };
  onCleanup(() => {
    stop();
  });

  createEffect(
    () => ({
      sessionId: props.store.state.sessionId,
      busy: props.store.isBusy(),
      since: props.store.state.turnElapsedMs,
    }),
    ({ sessionId, busy, since }) => {
      const measure = (): void => {
        setElapsed(Date.now() - startedAt);
      };
      if (sessionId !== timing) {
        timing = sessionId;
        stop();
        setElapsed(undefined);
      }
      const ticking = timer !== undefined;
      if (!busy) {
        if (ticking) {
          stop();
          measure();
        }
        return;
      }
      if (since === undefined) {
        return;
      }
      startedAt = ticking ? anchor(startedAt, since) : Date.now() - since;
      timer ??= setInterval(measure, 1000);
      measure();
    }
  );

  return (
    // `undefined`, not falsy: a turn one tick old measures zero, and zero is a reading.
    <Show when={shown() !== undefined}>
      <div
        class="pointer-events-auto flex items-center gap-1.5 rounded-lg bg-neutral-900 px-2.5 py-1 text-sm text-neutral-350 tabular-nums ring-1 ring-neutral-750"
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

function anchor(startedAt: number, since: number): number {
  const origin = Date.now() - since;
  return origin < startedAt || origin - startedAt > TURN_SLACK_MS
    ? origin
    : startedAt;
}

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
