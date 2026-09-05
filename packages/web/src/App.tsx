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
import { Transcript } from "./transcript/Transcript";
import { Drawer } from "./ui/Drawer";

const DEFAULT_PORT = 4319;
/** `md`, the one breakpoint that decides drawer or column. */
const DESKTOP = "(min-width: 48rem)";
/** How far off the end still counts as reading the end, in pixels. */
const SLACK = 40;

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
 * The client owns scroll anchoring, as it owns draft state and collapse — the
 * server has no opinion about any of it (see "Target Architecture": the client
 * is business-logic-free, not dumb). Anchoring is conditional on the reader
 * already being at the bottom, so scrolling up to read a tool result is not
 * yanked away by the next delta. On a phone it also re-runs when the software
 * keyboard resizes the visual viewport.
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
  let scroller!: HTMLDivElement;
  let pinned = true;
  // Where the transcript was last left, by the reader or by this component.
  // A scroll event says a position changed, never who changed it, and the
  // two are told apart by direction: only a reader moves the end away.
  let anchor = 0;
  // What the floating composer covers: its card, the pill row above it and
  // the padding around both. The transcript reserves this much padding plus
  // a blank row, so its last line clears the pills rather than scrolling
  // under them.
  const [inset, setInset] = createSignal(0);

  // Every write to `scrollTop` goes through here, because the anchor has to
  // move with it: the browser clamps the value it is given and reports the
  // move one frame later, and an anchor left behind would make that late
  // report look like a reader's gesture.
  const scrollTo = (top: number): void => {
    scroller.scrollTop = top;
    anchor = scroller.scrollTop;
  };

  const stick = (): void => {
    if (pinned && scroller) {
      scrollTo(scroller.scrollHeight);
    }
  };

  // Re-pinning, for the two gestures that mean "I am reading the end again":
  // picking a session, which is a request to read it and a conversation is
  // read at its end — including the session already on screen, which the
  // store deliberately does not re-attach to — and sending a message, which
  // the reader expects to see land however far up they had scrolled.
  const jump = (): void => {
    pinned = true;
    scrollTo(scroller.scrollHeight);
  };

  createEffect(
    () =>
      props.store.state.durable.length +
      props.store.state.optimistic.length +
      props.store.liveSize(),
    stick
  );

  // The composer grows a line at a time as a draft is typed and collapses
  // when it is sent, and the padding under the transcript grows and shrinks
  // with it. Scrolling by the same delta holds the last line where it was
  // relative to the composer's top edge: the reader sees the text pushed up
  // and pulled back down, rather than sliding under the card.
  createEffect(
    () => inset(),
    (height, previous) => {
      if (pinned) {
        stick();
        return;
      }
      scrollTo(scroller.scrollTop + height - (previous ?? 0));
    }
  );

  const viewport = globalThis.visualViewport;
  viewport?.addEventListener("resize", stick);
  onCleanup(() => {
    viewport?.removeEventListener("resize", stick);
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
        <div class="flex h-12 shrink-0 items-center gap-2 border-b border-neutral-700 px-3">
          <button
            type="button"
            aria-label="Toggle sessions"
            class="flex size-8 items-center justify-center rounded-lg text-neutral-350 hover:bg-neutral-800 hover:text-neutral-50"
            onClick={() => {
              setSidebar((open) => !open);
            }}
          >
            <span class="i-griddy-icons:sidebar size-5" />
          </button>

          <div class="flex-1" />

          {/* Nothing to draw outside a git repository, which is also why the
              chip is not a button: the branch is read here, never set. */}
          <Show when={props.store.state.branch}>
            {(branch) => (
              <div class="flex h-8 items-center gap-1.5 rounded-lg bg-neutral-850 px-2 text-neutral-350">
                <span class="i-griddy-icons:code-branch size-4 shrink-0" />
                <span class="max-w-32 truncate text-sm">{branch()}</span>
                <Show when={props.store.state.dirty}>
                  <span class="text-amber-400" title="Uncommitted changes">
                    •
                  </span>
                </Show>
              </div>
            )}
          </Show>
        </div>

        <div class="relative min-h-0 flex-1">
          <div
            ref={(element: HTMLDivElement) => {
              scroller = element;
            }}
            class="h-full overflow-y-auto"
            onScroll={() => {
              const top = scroller.scrollTop;
              const slack = scroller.scrollHeight - top - scroller.clientHeight;
              // Slack alone cannot answer this. A row is taller than the
              // flush that appended it — markdown parses, code blocks grow a
              // copy button, images arrive — and a scroll event is delivered
              // a frame after the position it reports was written, so the
              // scroll this component itself wrote to reach the end is read
              // back against a transcript that has since grown past it. Read
              // as slack, that is indistinguishable from the reader having
              // scrolled up, and unpinning there strands the transcript a
              // screenful short of its end for good: the observer that would
              // have caught the growth is now told to leave it alone.
              //
              // So the end is left only by moving away from it, which only a
              // reader does, and reaching it re-pins however it was reached.
              if (slack < SLACK) {
                pinned = true;
              } else if (top < anchor) {
                pinned = false;
              }
              anchor = top;
            }}
          >
            <div
              // The same anchoring again, driven by the transcript's own
              // height: a row is taller than the flush that appended it —
              // markdown parses into the DOM, code blocks grow a copy button,
              // images arrive — so a scroll written when the last event
              // landed stops short of the bottom by whatever grew after it.
              ref={(element: HTMLDivElement) => {
                observeHeight(element, stick);
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
            <Composer store={props.store} onSend={jump} />
          </div>
        </div>
      </div>
    </main>
  );
}

/**
 * An element's own height, reported as it changes.
 *
 * A `ResizeObserver` rather than a keystroke handler because the composer has
 * several ways to change height that are not typing — a wrapped model name,
 * an attachment row, the error line, a window resize — and a border-box
 * measurement catches every one of them at the moment layout settles.
 *
 * A DOM with no layout engine — the one the tests run in — reports zero
 * forever, which is the right answer there: nothing overlaps anything.
 */
function observeHeight(
  element: HTMLElement,
  report: (height: number) => void
): void {
  const observer = new ResizeObserver(() => {
    report(element.offsetHeight);
  });
  observer.observe(element);
  onCleanup(() => {
    observer.disconnect();
  });
}

/**
 * A media query as a signal. Not persisted and not a preference — it is what
 * the viewport currently is, which is why resizing a desktop window narrow
 * hands the sidebar to the drawer without a reload.
 */
function createMediaQuery(query: string): () => boolean {
  const list = globalThis.matchMedia?.(query);
  const [matches, setMatches] = createSignal(list?.matches ?? true);
  if (list) {
    const onChange = (event: MediaQueryListEvent): void => {
      setMatches(event.matches);
    };
    list.addEventListener("change", onChange);
    onCleanup(() => {
      list.removeEventListener("change", onChange);
    });
  }
  return matches;
}
