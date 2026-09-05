import { createEffect, createSignal, onCleanup, Show } from "solid-js";

import { Format } from "#core/shared/Format";
import type { SessionStore } from "../session/SessionStore";

/**
 * The one running indicator, at the foot of the transcript where the mockup
 * puts `Clanked for 2m 32s`. The agent status word, tok/s and the `seq`
 * readout are gone with the footer; this line is what replaced them, and it
 * says exactly what the TUI's working indicator says.
 *
 * Entirely client-side: the clock starts when the status leaves `idle`, so
 * nothing new has to travel on the wire. That also means it is only correct
 * for turns this client watched — after a reload the last turn's elapsed time
 * is unknown until Phase B gives messages timestamps.
 */
export function ClankLine(props: { readonly store: SessionStore }) {
  const [elapsed, setElapsed] = createSignal<number | undefined>(undefined);
  let startedAt = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stopTicking = (): void => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  onCleanup(stopTicking);

  createEffect(
    () => props.store.isBusy(),
    (busy) => {
      const measure = (): void => {
        setElapsed(Date.now() - startedAt);
      };
      if (busy) {
        startedAt = Date.now();
        measure();
        timer ??= setInterval(measure, 1000);
        return;
      }
      stopTicking();
      if (startedAt > 0) {
        measure();
      }
    }
  );

  return (
    <Show when={elapsed() !== undefined}>
      <div class="text-neutral-500">
        {`${props.store.isBusy() ? "Clanking…" : "Clanked for"} ${Format.formatElapsed(elapsed() ?? 0)}`}
      </div>
    </Show>
  );
}
