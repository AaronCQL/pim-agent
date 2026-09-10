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
import { GatewayOrigin } from "./session/Gateway";
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
import { observeHeight } from "./ui/scroll";
import { Drawer } from "./ui/Drawer";
import { createMediaQuery, DESKTOP } from "./ui/media";

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

/** The three regions: sidebar, topbar, and the transcript with the composer floating over its foot. */
export function Shell(props: {
  readonly store: SessionStore;
  readonly settings: Settings;
}) {
  const desktop = createMediaQuery(DESKTOP);
  const [sidebar, setSidebar] = createSignal(untrack(desktop));
  const [configuring, setConfiguring] = createSignal(false);
  createEffect(
    () => desktop(),
    (isDesktop) => {
      setSidebar(isDesktop);
    }
  );
  let scroller!: HTMLDivElement;
  const [inset, setInset] = createSignal(0);
  // An object rather than the string, so taking back the same words twice is two recalls.
  const [recalled, setRecalled] = createSignal<{ text: string }>();

  const recall = (): void => {
    void props.store.dequeue().then((text) => {
      if (text !== "") {
        setRecalled({ text });
      }
    });
  };

  const jump = (): void => {
    scroller.scrollTop = 0;
  };
  const hasTranscript = createMemo(
    (): boolean =>
      props.store.state.durable.length > 0 ||
      props.store.trailing().length > 0 ||
      props.store.liveSize() > 0
  );
  const showSplash = createMemo(
    (): boolean => !props.store.state.loading && !hasTranscript()
  );

  // `dvh` does not follow the software keyboard on iOS; only the visual viewport shrinks.
  const viewport = globalThis.visualViewport;
  const [viewportHeight, setViewportHeight] = createSignal(viewport?.height);
  const resizeViewport = (): void => {
    setViewportHeight(viewport?.height);
  };
  viewport?.addEventListener("resize", resizeViewport);
  onCleanup(() => {
    viewport?.removeEventListener("resize", resizeViewport);
  });

  return (
    <GatewayOrigin value={() => props.store.httpUrl}>
      <HideThinking value={() => props.settings.state.hideThinking}>
        <main
          class="flex overflow-hidden bg-neutral-925 text-neutral-100"
          style={{
            height:
              viewportHeight() === undefined
                ? "100dvh"
                : `${viewportHeight()}px`,
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
            {/* Only the live host is mounted: two Sidebars would each query the server. */}
            <Show when={!desktop()}>
              <Sidebar
                store={props.store}
                onNavigate={() => {
                  setSidebar(false);
                  jump();
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
              onToggleSidebar={() => {
                setSidebar((open) => !open);
              }}
              onOpenSettings={() => {
                setConfiguring(true);
              }}
            />

            <div class="relative min-h-0 flex-1">
              <div
                ref={(element: HTMLDivElement) => {
                  scroller = element;
                }}
                class="flex h-full flex-col-reverse overflow-y-auto"
              >
                <div
                  class="mx-auto min-h-full w-full max-w-3xl flex-none space-y-[--line] p-3 leading-[--line]"
                  style={{
                    "padding-bottom": `calc(${inset()}px + var(--line))`,
                  }}
                >
                  <Show
                    when={!props.store.state.loading}
                    fallback={<Skeleton />}
                  >
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
    </GatewayOrigin>
  );
}
