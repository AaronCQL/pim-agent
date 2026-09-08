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
 * How far the server's reading may sit *behind* the clock in hand before it
 * is read as a different turn rather than as the same one measured better.
 * Latency can only ever make a turn look younger than it is, so a figure
 * this much younger cannot be about the turn being timed.
 */
const TURN_SLACK_MS = 2_000;

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
 * The running clock is client-side but not client-*started*: it is anchored
 * to the server's `turnElapsedMs` and does not run at all until one has
 * arrived, so a turn that began before this client was watching is timed
 * from where it actually began. A turn whose age has not been stated yet is
 * shown as nothing rather than as zero — the reader is told the chip has no
 * answer yet, not told a wrong one it has to watch correct itself. A client
 * reading a *settled* session — a reload, a phone that woke up — takes the
 * figure off the durable log instead, as last user message → last assistant
 * message. Neither needs `turn_end` to be persisted, which is why it never
 * is.
 *
 * The clock belongs to the conversation and not to the tab: this is mounted
 * once and every session borrows it, so switching hands back a blank chip —
 * a new chat has timed nothing, and an old one is timed by its own log.
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
  /** The session the reading on screen is about; "" is nobody's. */
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
      // A switch takes the reading with it: what the session being left
      // clanked for is not this session's news, and leaving it up would time
      // a brand-new chat by a turn it never ran.
      if (sessionId !== timing) {
        timing = sessionId;
        stop();
        setElapsed(undefined);
      }
      const ticking = timer !== undefined;
      if (!busy) {
        // Idle on the run rather than on the edge would keep growing a turn
        // that has already ended: a branch poll is another `session_state`.
        if (ticking) {
          stop();
          measure();
        }
        return;
      }
      // Working, and how long for is not known yet: the status can arrive
      // ahead of the state that dates it — a session opened mid-turn is
      // known to be running by the listing a round trip before the server
      // says since when. It may have been going for an hour, so there is
      // nothing honest to draw until the answer lands.
      if (since === undefined) {
        return;
      }
      // The agent status moves between `thinking`, `streaming` and `tool`
      // for the whole of one turn and the effect re-runs on each of those,
      // so the clock is only started once — and where it is started from is
      // the server's answer, which can improve while the turn runs.
      startedAt = ticking ? anchor(startedAt, since) : Date.now() - since;
      timer ??= setInterval(measure, 1000);
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
 * Where the running turn began, given where we thought it began and what the
 * server says. Taken when it is *older* than the origin in hand — the wire
 * delay between the reading and its arrival can only ever make a turn look
 * younger, so an older answer is the truer one — and taken when it is much
 * younger, which is not the same turn measured again but the next one.
 */
function anchor(startedAt: number, since: number): number {
  const origin = Date.now() - since;
  return origin < startedAt || origin - startedAt > TURN_SLACK_MS
    ? origin
    : startedAt;
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
