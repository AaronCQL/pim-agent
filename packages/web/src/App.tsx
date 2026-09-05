import { createEffect, createSignal, onCleanup, Show } from "solid-js";

import { Composer } from "./input/Composer";
import { SessionStore } from "./session/SessionStore";
import { Sidebar } from "./sessions/Sidebar";
import { ClankLine } from "./transcript/ClankLine";
import { Transcript } from "./transcript/Transcript";
import { Drawer } from "./ui/Drawer";

const DEFAULT_PORT = 4319;
/** `md`, the one breakpoint that decides drawer or column. */
const DESKTOP = "(min-width: 48rem)";

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

  const stick = (): void => {
    if (pinned) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  };

  createEffect(
    () =>
      props.store.state.durable.length +
      props.store.state.optimistic.length +
      props.store.state.liveTools.length +
      props.store.state.liveText.length,
    stick
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
          <Sidebar store={props.store} />
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
              const slack =
                scroller.scrollHeight -
                scroller.scrollTop -
                scroller.clientHeight;
              pinned = slack < 40;
            }}
          >
            <div class="mx-auto w-full max-w-3xl space-y-[--line] p-3 pb-32 leading-[--line]">
              <Transcript
                events={props.store.state.durable}
                trailing={props.store.trailing()}
                streamingId={props.store.streamingId()}
              />
              <ClankLine store={props.store} />
            </div>
          </div>

          <div class="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-neutral-925 via-neutral-925 to-transparent px-3 pt-10 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <Composer store={props.store} />
          </div>
        </div>
      </div>
    </main>
  );
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
