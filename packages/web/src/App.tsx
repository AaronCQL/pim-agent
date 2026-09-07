import {
  createEffect,
  createSignal,
  onCleanup,
  onSettled,
  Show,
} from "solid-js";

import { Composer } from "./input/Composer";
import { SessionStore } from "./session/SessionStore";
import { Sidebar } from "./sessions/Sidebar";
import { Skeleton } from "./transcript/Skeleton";
import { SubagentModal } from "./transcript/SubagentModal";
import { Transcript } from "./transcript/Transcript";
import { Topbar } from "./topbar/Topbar";
import { createScrollAnchor, observeHeight } from "./ui/anchor";
import { Drawer } from "./ui/Drawer";
import { createMediaQuery, DESKTOP } from "./ui/media";

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
  // Attaching is imperative IO whose first act is a status write, and a
  // component body may not write reactive state — dev Solid throws
  // REACTIVE_WRITE_IN_OWNED_SCOPE, which `connect()` then reports as a
  // rejection, so the socket is never opened and the app paints empty
  // against a healthy server. `onSettled` is the effect phase, where the
  // write is legal, and its returned cleanup is this component's teardown.
  onSettled(() => {
    // A refused or unreachable gateway is not exceptional — `WsClient`
    // reconnects on its own and `state.connection` is what the UI paints.
    void store.connect().catch(() => undefined);
    return () => {
      store.dispose();
    };
  });

  return <Shell store={store} />;
}

/**
 * The three regions: sidebar, topbar, and the transcript with the composer
 * floating over its foot.
 *
 * Scroll anchoring is the client's, as draft state and collapse are — the
 * server has no opinion about any of it (see "Target Architecture": the client
 * is business-logic-free, not dumb). Here it hangs off three things the
 * anchor cannot see for itself: the store growing, the composer changing
 * height, and — on a phone — the software keyboard resizing the visual
 * viewport.
 *
 * One `sidebar` signal drives both hosts of `Sidebar`: above `md` it collapses
 * the in-place column, below it opens the drawer. Which host is live is not
 * state — it is the media query — so it is tracked separately and decides the
 * signal's initial value: a phone must not start with the drawer open.
 */
export function Shell(props: { readonly store: SessionStore }) {
  const desktop = createMediaQuery(DESKTOP);
  const [sidebar, setSidebar] = createSignal(desktop());
  // Crossing the breakpoint hands the sidebar to the other host, and the two
  // want opposite defaults: a column is open, a modal drawer is not.
  createEffect(
    () => desktop(),
    (isDesktop) => {
      setSidebar(isDesktop);
    }
  );
  const anchor = createScrollAnchor();
  // What the floating composer covers: its card, the pill row above it and
  // the padding around both. The transcript reserves this much padding plus
  // a blank row, so its last line clears the pills rather than scrolling
  // under them.
  const [inset, setInset] = createSignal(0);
  // What the transcript handed back to the composer. An object rather than
  // the string, so taking back the same words twice is two recalls.
  const [recalled, setRecalled] = createSignal<{ text: string }>();

  /**
   * A queued card was clicked: pi gives the message up, the row goes with it,
   * and the words land in the box to be said differently. The turn keeps
   * running — this is an edit, not a stop.
   */
  const recall = (): void => {
    void props.store.dequeue().then((text) => {
      if (text !== "") {
        setRecalled({ text });
      }
    });
  };

  // Re-pinning, for the two gestures that mean "I am reading the end again":
  // picking a session, which is a request to read it and a conversation is
  // read at its end — including the session already on screen, which the
  // store deliberately does not re-attach to — and sending a message, which
  // the reader expects to see land however far up they had scrolled.
  const jump = anchor.jump;

  createEffect(
    () =>
      props.store.state.durable.length +
      props.store.state.optimistic.length +
      props.store.liveSize(),
    anchor.stick
  );

  // The composer grows a line at a time as a draft is typed and collapses
  // when it is sent, and the padding under the transcript grows and shrinks
  // with it. Scrolling by the same delta holds the last line where it was
  // relative to the composer's top edge: the reader sees the text pushed up
  // and pulled back down, rather than sliding under the card.
  createEffect(
    () => inset(),
    (height, previous) => {
      anchor.shift(height - (previous ?? 0));
    }
  );

  const viewport = globalThis.visualViewport;
  viewport?.addEventListener("resize", anchor.stick);
  onCleanup(() => {
    viewport?.removeEventListener("resize", anchor.stick);
  });

  return (
    <main class="flex h-[100dvh] overflow-hidden bg-neutral-925 text-neutral-100">
      <Show when={desktop() && sidebar()}>
        <div class="w-xs shrink-0 border-r border-neutral-700">
          <Sidebar store={props.store} onNavigate={jump} />
        </div>
      </Show>

      <Drawer
        open={!desktop() && sidebar()}
        label="Sessions"
        onClose={() => {
          setSidebar(false);
        }}
      >
        {/* Only the live host is mounted: two Sidebars would each query the
            server and put the same list in the DOM twice. */}
        <Show when={!desktop()}>
          <Sidebar
            store={props.store}
            onNavigate={() => {
              setSidebar(false);
              jump();
            }}
          />
        </Show>
      </Drawer>

      <div class="flex w-full min-w-0 flex-col">
        <Topbar
          store={props.store}
          compact={!desktop()}
          onToggleSidebar={() => {
            setSidebar((open) => !open);
          }}
        />

        <div class="relative min-h-0 flex-1">
          <div
            ref={anchor.mount}
            class="h-full overflow-y-auto"
            onScroll={anchor.onScroll}
          >
            <div
              // The same anchoring again, driven by the transcript's own
              // height: a row is taller than the flush that appended it —
              // markdown parses into the DOM, code blocks grow a copy button,
              // images arrive — so a scroll written when the last event
              // landed stops short of the bottom by whatever grew after it.
              ref={(element: HTMLDivElement) => {
                observeHeight(element, anchor.stick);
              }}
              class="mx-auto w-full max-w-3xl space-y-[--line] p-3 leading-[--line]"
              style={{ "padding-bottom": `calc(${inset()}px + var(--line))` }}
            >
              {/* Whole or not at all: a conversation that paints itself row
                  by row as the log arrives is a flicker, not progress. */}
              <Show when={!props.store.state.loading} fallback={<Skeleton />}>
                <Transcript
                  events={props.store.state.durable}
                  trailing={props.store.trailing()}
                  live={props.store.state.live}
                  onEdit={recall}
                  onOpenSubagent={(callId) => {
                    void props.store.watch(callId);
                  }}
                />
              </Show>
            </div>
          </div>

          <div
            ref={(element: HTMLDivElement) => {
              observeHeight(element, setInset);
            }}
            // Stops at the scroller's scrollbar instead of at the container's
            // edge: the transcript scrolls under this backdrop, so covering
            // the scrollbar column would hide the thumb exactly where the
            // reader is dragging it.
            class="pointer-events-none absolute right-[--scrollbar] bottom-0 left-0 flex justify-center bg-neutral-925 px-3 pt-10 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
          >
            <Composer store={props.store} onSend={jump} recalled={recalled()} />
          </div>
        </div>
      </div>
      <SubagentModal store={props.store} />

      <Show
        when={
          props.store.update.state.pending || props.store.update.state.notice
        }
      >
        <div
          role="status"
          class={{
            "fixed right-3 bottom-3 z-50 flex max-w-sm items-start gap-3 rounded-lg bg-neutral-850 p-3 text-sm shadow-lg ring-1 ring-neutral-700": true,
            "text-emerald-400":
              props.store.update.state.notice?.tone === "success",
            "text-amber-400":
              props.store.update.state.notice?.tone === "warning",
            "text-rose-400": props.store.update.state.notice?.tone === "error",
          }}
        >
          <span>
            {props.store.update.state.pending
              ? props.store.update.state.label
              : props.store.update.state.notice?.text}
          </span>
          <Show when={props.store.update.state.notice}>
            <button
              type="button"
              aria-label="Dismiss notification"
              class="flex size-5 shrink-0 items-center justify-center"
              onClick={() => props.store.update.dismiss()}
            >
              <span
                class="i-solar:close-circle-bold size-4"
                aria-hidden="true"
              />
            </button>
          </Show>
        </div>
      </Show>
    </main>
  );
}
