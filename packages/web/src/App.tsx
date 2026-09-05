import { createEffect, onCleanup } from "solid-js";

import { Approvals } from "./approvals/Approvals";
import { Footer } from "./Footer";
import { Composer } from "./input/Composer";
import { SessionStore } from "./session/SessionStore";
import { SessionSwitcher } from "./sessions/SessionSwitcher";
import { Transcript } from "./transcript/Transcript";

const DEFAULT_PORT = 4319;

/** Same origin in production, because `pim-server` serves this bundle itself. */
function gatewayUrl(): string {
  const override = import.meta.env.VITE_PIM_SERVER;
  if (override !== undefined && override !== "") {
    return override;
  }
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const host = import.meta.env.DEV
    ? `${location.hostname}:${DEFAULT_PORT}`
    : location.host;
  return `${protocol}//${host}`;
}

export function App() {
  const store = new SessionStore({ url: gatewayUrl() });
  void store.connect().catch(() => undefined);
  onCleanup(() => {
    store.dispose();
  });

  return <Shell store={store} />;
}

/**
 * The client owns scroll anchoring, as it owns draft state and collapse — the
 * server has no opinion about any of it (see "Target Architecture": the client
 * is business-logic-free, not dumb). Anchoring is conditional on the reader
 * already being at the bottom, so scrolling up to read a tool result is not
 * yanked away by the next delta.
 */
export function Shell(props: { readonly store: SessionStore }) {
  let scroller!: HTMLDivElement;
  let pinned = true;

  createEffect(
    () =>
      props.store.state.durable.length +
      props.store.state.optimistic.length +
      props.store.state.liveTools.length +
      props.store.state.liveText.length,
    () => {
      if (pinned) {
        scroller.scrollTop = scroller.scrollHeight;
      }
    }
  );

  return (
    <main class="mx-auto flex h-dvh max-w-3xl flex-col gap-3 p-3">
      <header class="flex items-center justify-between border-b border-neutral-800 pb-2">
        <h1 class="font-medium text-neutral-100">pim</h1>
        <SessionSwitcher store={props.store} />
      </header>

      <div
        ref={(element: HTMLDivElement) => {
          scroller = element;
        }}
        class="min-h-0 flex-1 overflow-y-auto"
        onScroll={() => {
          const slack =
            scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
          pinned = slack < 40;
        }}
      >
        <Transcript
          events={props.store.state.durable}
          trailing={props.store.trailing()}
          streamingId={props.store.streamingId()}
        />
      </div>

      <Approvals store={props.store} />
      <Composer store={props.store} />
      <Footer store={props.store} />
    </main>
  );
}
