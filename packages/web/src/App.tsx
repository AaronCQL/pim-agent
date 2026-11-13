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
import type { ReviewMode } from "./diff/ModeSwitch";
import { Review } from "./diff/Review";
import { FileStore } from "./files/FileStore";
import { FilesView } from "./files/FilesView";
import { CommandModal } from "./session/CommandModal";
import { GatewayOrigin } from "./session/Gateway";
import { NoticeToast } from "./session/NoticeToast";
import { SessionStore } from "./session/SessionStore";
import { Toast } from "./session/Toast";
import { Sidebar } from "./sessions/Sidebar";
import { SearchModal } from "./sessions/SearchModal";
import { HideThinking, Settings } from "./settings/Settings";
import { SettingsModal } from "./settings/SettingsModal";
import { Skeleton } from "./transcript/Skeleton";
import { Splash } from "./transcript/Splash";
import { Jumps } from "./transcript/Jumps";
import { createReader } from "./transcript/reader";
import { SubagentModal } from "./transcript/SubagentModal";
import { Transcript } from "./transcript/Transcript";
import { Topbar } from "./topbar/Topbar";
import { observeHeight } from "./ui/scroll";
import { Drawer } from "./ui/Drawer";
import { Fade } from "./ui/Fade";
import { createBackGuard } from "./ui/history";
import { createMediaQuery, DESKTOP } from "./ui/media";
import { createSwipe } from "./ui/swipe";
import { createViewportHeight } from "./ui/viewport";

export function App() {
  const settings = new Settings();
  const store = new SessionStore({ url: settings.gateway() });
  // `connect()` writes state, which a component body may not do.
  onSettled(() => {
    void store.connect().catch(() => undefined);
    return () => {
      store.dispose();
    };
  });

  return <Shell store={store} settings={settings} />;
}

const JUMP_KEYS: Readonly<Record<string, "up" | "down">> = {
  ArrowUp: "up",
  ArrowDown: "down",
};

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
  const files = new FileStore(props.store);
  const [mode, setMode] = createSignal<ReviewMode>("changes");
  /** A changed file the diff should scroll to. */
  const [focus, setFocus] = createSignal<string>();
  const comments = new Comments();
  const reader = createReader(() => inset());
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
  onSettled(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearching(true);
        return;
      }
      const jump = JUMP_KEYS[event.key];
      if (
        jump &&
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        !event.defaultPrevented &&
        !untrack(reviewing) &&
        !(event.target instanceof Element && event.target.closest("dialog"))
      ) {
        event.preventDefault();
        reader[jump]();
      }
    };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => {
      globalThis.removeEventListener("keydown", onKeyDown);
    };
  });
  const swipeOpen = createSwipe("right", () => {
    if (!untrack(desktop)) {
      setSidebar(true);
    }
  });
  const [overlay, setOverlay] = createSignal(0);
  // An object, so recalling the same text twice still fires.
  const [recalled, setRecalled] = createSignal<{ text: string }>();

  const review = (): void => {
    // Arming twice would leave a history entry that swallows the next Back.
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
    if (!props.store.state.branch) {
      setMode("files");
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

  const navigate = (): void => {
    converse();
    reader.jump();
  };

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

  /** Composer height over the transcript; 0 on the splash, which would otherwise show a needless scrollbar. */
  const inset = createMemo((): number => (showSplash() ? 0 : overlay()));

  let opening = { sessionId: "", unread: false, landed: false };
  createEffect(
    () => ({
      sessionId: props.store.state.sessionId,
      ready: !props.store.state.loading,
    }),
    ({ sessionId, ready }) => {
      // Snapshot before `session_read` arrives: it follows the replay.
      if (sessionId !== opening.sessionId) {
        opening = {
          sessionId,
          unread: untrack(() => props.store.isUnread(sessionId)),
          landed: false,
        };
      }
      if (ready && !opening.landed) {
        opening.landed = true;
        reader.open(
          opening.unread && untrack(() => props.store.state.agent) === "idle"
        );
      }
    }
  );

  const viewportHeight = createViewportHeight();

  const Conversation = () => (
    <div
      ref={reader.ref}
      class={{
        "isolate flex h-full flex-col-reverse overflow-y-auto": true,
        "[overflow-anchor:none]": reader.pinned(),
      }}
    >
      <Fade height={inset()} />
      <div
        ref={reader.content}
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
            {/* Mount one Sidebar only; each queries the server. */}
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

          <div ref={swipeOpen} class="flex w-full min-w-0 flex-col">
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
                  <Show
                    when={mode() === "files"}
                    fallback={
                      <DiffView
                        diff={diff}
                        settings={props.settings}
                        inset={inset()}
                        mode={mode()}
                        onMode={setMode}
                        onView={(path) => {
                          files.reveal(path);
                          setMode("files");
                        }}
                        focus={focus()}
                        onFocused={() => {
                          setFocus(undefined);
                        }}
                        onClose={converse}
                      />
                    }
                  >
                    <FilesView
                      files={files}
                      diff={diff}
                      inset={inset()}
                      mode={mode()}
                      onMode={setMode}
                      onDiff={(path) => {
                        diff.reveal(path);
                        setFocus(path);
                        setMode("changes");
                      }}
                      onClose={converse}
                    />
                  </Show>
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
                      chips={
                        <Show when={!reviewing() && hasTranscript()}>
                          <Jumps reader={reader} />
                        </Show>
                      }
                    />
                  </div>
                </div>
              </div>

              <Toast update={props.store.update} desktop={desktop()} />
              <NoticeToast
                notices={props.store.state.toasts}
                desktop={desktop()}
                onDismiss={(id) => {
                  props.store.dismissToast(id);
                }}
              />
            </div>
          </div>
          <SubagentModal store={props.store} />
          <CommandModal store={props.store} />
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
