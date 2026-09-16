import {
  createEffect,
  createMemo,
  createSignal,
  onSettled,
  Show,
  untrack,
} from "solid-js";

import { Composer } from "./input/Composer";
import { Comments, ReviewComments } from "./diff/Comments";
import { DiffStore } from "./diff/DiffStore";
import { DiffView } from "./diff/DiffView";
import { Review } from "./diff/Review";
import { GatewayOrigin } from "./session/Gateway";
import { SessionStore } from "./session/SessionStore";
import { Toast } from "./session/Toast";
import { Sidebar } from "./sessions/Sidebar";
import { SearchModal } from "./sessions/SearchModal";
import { HideThinking, Settings } from "./settings/Settings";
import { SettingsModal } from "./settings/SettingsModal";
import { Skeleton } from "./transcript/Skeleton";
import { Splash } from "./transcript/Splash";
import { SubagentModal } from "./transcript/SubagentModal";
import { Transcript } from "./transcript/Transcript";
import { Topbar } from "./topbar/Topbar";
import { createBottomPin, observeHeight } from "./ui/scroll";
import { Drawer } from "./ui/Drawer";
import { Fade } from "./ui/Fade";
import { createBackGuard } from "./ui/history";
import { createMediaQuery, DESKTOP } from "./ui/media";
import { createViewportHeight } from "./ui/viewport";

export function App() {
  const settings = new Settings();
  const store = new SessionStore({ url: settings.gateway() });
  // Connect in the effect phase: `connect()` writes state, illegal in a component body.
  onSettled(() => {
    void store.connect().catch(() => undefined);
    return () => {
      store.dispose();
    };
  });

  return <Shell store={store} settings={settings} />;
}

/** The three regions: sidebar, topbar, and the transcript — or the change set — with the composer floating over its foot. */
export function Shell(props: {
  readonly store: SessionStore;
  readonly settings: Settings;
}) {
  const desktop = createMediaQuery(DESKTOP);
  const [sidebar, setSidebar] = createSignal(untrack(desktop));
  const [configuring, setConfiguring] = createSignal(false);
  const [searching, setSearching] = createSignal(false);
  const [reviewing, setReviewing] = createSignal(false);
  const diff = new DiffStore(props.store);
  const comments = new Comments();
  const back = createBackGuard(() => {
    setReviewing(false);
  });
  createEffect(
    () => desktop(),
    (isDesktop) => {
      setSidebar(isDesktop);
    }
  );
  createEffect(
    () => diff.cwd(),
    (cwd) => {
      comments.load(cwd);
    }
  );
  // The icon is the discoverable way in; this is for the fingers that already know.
  onSettled(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearching(true);
      }
    };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => {
      globalThis.removeEventListener("keydown", onKeyDown);
    };
  });
  const pin = createBottomPin();
  const [overlay, setOverlay] = createSignal(0);
  // An object rather than the string, so taking back the same words twice is two recalls.
  const [recalled, setRecalled] = createSignal<{ text: string }>();

  const review = (): void => {
    // A second arm behind one release leaves an entry that swallows the next Back.
    if (untrack(reviewing)) {
      return;
    }
    setReviewing(true);
    back.arm();
  };

  const converse = (): void => {
    setReviewing(false);
    back.release();
  };

  const toggleReview = (): void => {
    if (untrack(reviewing)) {
      converse();
      return;
    }
    review();
  };

  const recall = (): void => {
    void props.store.dequeue().then((text) => {
      if (text !== "") {
        setRecalled({ text });
      }
    });
  };

  /** Back to the transcript, at its end: where both a session switch and a sent message land. */
  const navigate = (): void => {
    converse();
    pin.jump();
  };

  /** A review is over the moment it is sent, and the moment it is thrown away. */
  const clearReview = (): void => {
    comments.clear();
  };

  const pending = createMemo(() => ({
    count: comments.all().length,
    text: () =>
      untrack(() =>
        Review.compose(diff.state.base, comments.all(), diff.files())
      ),
    sent: clearReview,
    discard: clearReview,
    open: review,
  }));

  const hasTranscript = createMemo(
    (): boolean =>
      props.store.state.durable.length > 0 ||
      props.store.trailing().length > 0 ||
      props.store.liveSize() > 0
  );
  const showSplash = createMemo(
    (): boolean =>
      !reviewing() && !props.store.state.loading && !hasTranscript()
  );

  /**
   * How much of the transcript's foot the composer covers. Nothing under the
   * splash, where the composer lies over the whole pane rather than its foot:
   * charging its height there pads an empty transcript past its own scroller
   * and raises a scrollbar over nothing.
   */
  const inset = createMemo((): number => (showSplash() ? 0 : overlay()));

  const viewportHeight = createViewportHeight();

  const Conversation = () => (
    <div
      ref={pin.ref}
      class={{
        "isolate flex h-full flex-col-reverse overflow-y-auto": true,
        "[overflow-anchor:none]": pin.pinned(),
      }}
    >
      {/* First in a reversed column is the foot of the transcript. */}
      <Fade height={inset()} />
      <div
        class="mx-auto min-h-full w-full max-w-3xl flex-none space-y-[--line] p-3 leading-[--line]"
        style={{ "padding-bottom": `calc(${inset()}px + var(--line))` }}
      >
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
  );

  return (
    <GatewayOrigin value={() => props.store.httpUrl}>
      <HideThinking value={() => props.settings.state.hideThinking}>
        <main
          class="flex overflow-hidden bg-neutral-925 text-neutral-100"
          style={{ height: viewportHeight() }}
        >
          <Show when={desktop() && sidebar()}>
            <div class="w-xs shrink-0 border-r border-neutral-700">
              <Sidebar
                store={props.store}
                onNavigate={navigate}
                onOpenSearch={() => {
                  setSearching(true);
                }}
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
            {/* Only the live host is mounted: two Sidebars would each query the server. */}
            <Show when={!desktop()}>
              <Sidebar
                store={props.store}
                onNavigate={() => {
                  setSidebar(false);
                  navigate();
                }}
                onOpenSearch={() => {
                  setSidebar(false);
                  setSearching(true);
                }}
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
              reviewing={reviewing()}
              onToggleSidebar={() => {
                setSidebar((open) => !open);
              }}
              onToggleDiff={toggleReview}
              onOpenSettings={() => {
                setConfiguring(true);
              }}
            />

            <div class="relative min-h-0 flex-1">
              <Show when={reviewing()} fallback={<Conversation />}>
                <ReviewComments value={() => comments}>
                  <DiffView
                    diff={diff}
                    settings={props.settings}
                    inset={inset()}
                    onClose={converse}
                  />
                </ReviewComments>
              </Show>

              <div
                ref={observeHeight(setOverlay)}
                class={{
                  "pointer-events-none flex": true,
                  "absolute right-[--scrollbar] bottom-0 left-0 justify-center px-3 pt-10 pb-[max(0.75rem,env(safe-area-inset-bottom))]":
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
                      onSend={navigate}
                      recalled={recalled()}
                      review={pending()}
                    />
                  </div>
                </div>
              </div>

              <Toast update={props.store.update} desktop={desktop()} />
            </div>
          </div>
          <SubagentModal store={props.store} />
          <SearchModal
            open={searching()}
            store={props.store}
            onNavigate={navigate}
            onClose={() => {
              setSearching(false);
            }}
          />
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
    </GatewayOrigin>
  );
}
