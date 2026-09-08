import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onSettled,
  Show,
  untrack,
} from "solid-js";

import { Composer } from "./input/Composer";
import { SessionStore } from "./session/SessionStore";
import { Toast } from "./session/Toast";
import { Sidebar } from "./sessions/Sidebar";
import { HideThinking, Settings } from "./settings/Settings";
import { SettingsModal } from "./settings/SettingsModal";
import { Skeleton } from "./transcript/Skeleton";
import { Splash } from "./transcript/Splash";
import { SubagentModal } from "./transcript/SubagentModal";
import { Transcript } from "./transcript/Transcript";
import { Topbar } from "./topbar/Topbar";
import { createScrollAnchor, observeHeight } from "./ui/scroll";
import { Drawer } from "./ui/Drawer";
import { createMediaQuery, DESKTOP } from "./ui/media";

export function App() {
  // Read before the store exists, because which machine this tab drives is
  // fixed at construction: the socket, the upload endpoint and every image
  // URL are all derived from the one address.
  const settings = new Settings();
  const store = new SessionStore({ url: settings.gateway() });
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

  return <Shell store={store} settings={settings} />;
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
export function Shell(props: {
  readonly store: SessionStore;
  readonly settings: Settings;
}) {
  const desktop = createMediaQuery(DESKTOP);
  const [sidebar, setSidebar] = createSignal(untrack(desktop));
  const [configuring, setConfiguring] = createSignal(false);
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
  const hasTranscript = createMemo(
    (): boolean =>
      props.store.state.durable.length > 0 ||
      props.store.trailing().length > 0 ||
      props.store.liveSize() > 0
  );
  const showSplash = createMemo(
    (): boolean => !props.store.state.loading && !hasTranscript()
  );

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

  // `dvh` follows browser chrome but, notably on iOS, not the software
  // keyboard: only the visual viewport shrinks. Mirroring that measurement is
  // what keeps the composer inside the pixels that remain visible. The
  // viewport meta tag makes the same thing happen without this fallback in
  // browsers that implement `interactive-widget=resizes-content`.
  const viewport = globalThis.visualViewport;
  const [viewportHeight, setViewportHeight] = createSignal(viewport?.height);
  const resizeViewport = (): void => {
    setViewportHeight(viewport?.height);
    anchor.stick();
  };
  viewport?.addEventListener("resize", resizeViewport);
  onCleanup(() => {
    viewport?.removeEventListener("resize", resizeViewport);
  });

  return (
    <HideThinking value={() => props.settings.state.hideThinking}>
      <main
        class="flex overflow-hidden bg-neutral-925 text-neutral-100"
        style={{
          height:
            viewportHeight() === undefined ? "100dvh" : `${viewportHeight()}px`,
        }}
      >
        <Show when={desktop() && sidebar()}>
          <div class="w-xs shrink-0 border-r border-neutral-700">
            <Sidebar
              store={props.store}
              onNavigate={jump}
              onOpenSettings={() => {
                setConfiguring(true);
              }}
            />
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
              // The drawer is the modal's own backdrop's business otherwise:
              // a settings dialog opened over a sheet is two layers deep on
              // the device with the least room for either.
              onOpenSettings={() => {
                setSidebar(false);
                setConfiguring(true);
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
            onOpenSettings={() => {
              setConfiguring(true);
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
                ref={observeHeight(anchor.stick)}
                class="mx-auto w-full max-w-3xl space-y-[--line] p-3 leading-[--line]"
                style={{ "padding-bottom": `calc(${inset()}px + var(--line))` }}
              >
                {/* Whole or not at all: a conversation that paints itself row
                  by row as the log arrives is a flicker, not progress. */}
                <Show when={!props.store.state.loading} fallback={<Skeleton />}>
                  <Show when={hasTranscript()}>
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
                </Show>
              </div>
            </div>

            <div
              ref={observeHeight(setInset)}
              class={{
                "pointer-events-none flex": true,
                // Stops at the scroller's scrollbar instead of at the
                // container's edge: the transcript scrolls under this backdrop,
                // so covering the scrollbar column would hide the thumb exactly
                // where the reader is dragging it.
                "absolute right-[--scrollbar] bottom-0 left-0 justify-center bg-neutral-925 px-3 pt-10 pb-[max(0.75rem,env(safe-area-inset-bottom))]":
                  !showSplash(),
                "absolute inset-0 items-center justify-center overflow-hidden px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]":
                  showSplash(),
              }}
            >
              <div
                class={{
                  "w-full max-w-3xl": true,
                  "flex max-h-full flex-col": showSplash(),
                }}
              >
                <Show when={showSplash()}>
                  {/* The composer owns the scarce space. Once it grows past the
                    room left by the keyboard, this viewport gives up the
                    bottom of the decorative splash rather than letting the
                    whole stack overflow behind the topbar. */}
                  <div class="min-h-0 overflow-hidden">
                    <Splash />
                  </div>
                </Show>
                <div
                  class={{
                    "mt-[calc(var(--line)*2)] shrink-0": showSplash(),
                  }}
                >
                  <Composer
                    store={props.store}
                    onSend={jump}
                    recalled={recalled()}
                  />
                </div>
              </div>
            </div>

            {/* Last, so it paints over both the transcript and the
                composer's backdrop, and inside this container rather than the
                page, so its top edge is the topbar's bottom edge on every
                device. */}
            <Toast update={props.store.update} desktop={desktop()} />
          </div>
        </div>
        <SubagentModal store={props.store} />
        <SettingsModal
          open={configuring()}
          store={props.store}
          settings={props.settings}
          onClose={() => {
            setConfiguring(false);
          }}
        />
      </main>
    </HideThinking>
  );
}
