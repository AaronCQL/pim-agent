import type { DurableEvent } from "../../protocol/src/ServerEvent";
import events from "./replay/fixtures/events.json";
import { Transcript } from "./transcript/Transcript";

/**
 * Build-order step 1: a persisted session, replayed with no live connection.
 * The events are the committed projection of a real pi log, which is exactly
 * what the gateway will push over the wire in step 2 — so the painter is
 * already being validated against real data, minus the WebSocket.
 */
export function App() {
  return (
    <main class="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <header class="flex items-baseline justify-between border-b border-neutral-800 pb-2">
        <h1 class="text-neutral-100 font-medium">pim</h1>
        <span class="font-mono text-xs text-neutral-500">
          {events.length} events
        </span>
      </header>
      <Transcript events={events as readonly DurableEvent[]} />
      <footer class="pt-2 text-center text-xs text-neutral-600">
        static replay — no connection
      </footer>
    </main>
  );
}
