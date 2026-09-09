import { createEffect, createSignal, onCleanup, Show } from "solid-js";

import { abbreviateHome, baseName, fit } from "../format";
import type { SessionStore } from "../session/SessionStore";
import type { ConnectionStatus } from "../ws/WsClient";
import { DirectoryModal } from "./DirectoryModal";

const CHIP =
  "flex h-8 max-w-max min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-neutral-850 px-2 text-sm text-neutral-350";

// Not the footer's U+F069: that is a Nerd Font glyph, and no browser has the font.
const DIRTY_MARK = "\u2736";

const GRACE_MS = 1500;

// Sub-pixel slack, or a box a hair under its own text elides a text that fits.
const SLACK = 0.02;

/** The row above the transcript: where the session is, and what its repository is doing. */
export function Topbar(props: {
  readonly store: SessionStore;
  readonly compact: boolean;
  readonly onToggleSidebar: () => void;
  readonly onOpenSettings?: () => void;
  readonly graceMs?: number;
}) {
  const [choosing, setChoosing] = createSignal(false);
  const offline = createOffline(
    () => props.store.state.connection,
    () => props.graceMs ?? GRACE_MS
  );
  const paths = (cwd: string): readonly string[] =>
    props.compact ? [baseName(cwd)] : [abbreviateHome(cwd), baseName(cwd)];

  return (
    <div class="flex h-12 shrink-0 items-center gap-2 border-b border-neutral-700 px-3">
      <button
        type="button"
        aria-label="Toggle sessions"
        class="flex size-8 shrink-0 items-center justify-center rounded-lg text-neutral-350 hover:bg-neutral-800 hover:text-neutral-50"
        onClick={props.onToggleSidebar}
      >
        <span class="i-griddy-icons:sidebar size-5" />
      </button>

      <Show when={props.store.state.cwd}>
        {(cwd) => (
          <button
            type="button"
            class={`${CHIP} hover:bg-neutral-800 hover:text-neutral-50`}
            aria-label={`Working directory ${abbreviateHome(cwd())}, open another`}
            title={cwd()}
            onClick={() => {
              setChoosing(true);
            }}
          >
            <span class="i-griddy-icons:folder size-4 shrink-0" />
            <Fitted texts={paths(cwd())} />
          </button>
        )}
      </Show>

      <div class="ml-auto" />

      <Show when={offline()}>
        <button
          type="button"
          aria-label="Not connected"
          title="Not connected — reconnecting"
          class="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-rose-500/10 px-2 text-sm text-rose-400 hover:bg-rose-500/20"
          onClick={() => props.onOpenSettings?.()}
        >
          <span class="i-griddy-icons:link-off size-4 shrink-0" />
          <Show when={!props.compact}>Not connected</Show>
        </button>
      </Show>

      <Show when={props.store.state.branch}>
        {(branch) => (
          <div class={CHIP} title={branch()}>
            <span class="i-griddy-icons:code-branch size-4 shrink-0" />
            <Fitted texts={[branch()]} />
            <Show when={props.store.state.dirtyCount > 0}>
              <span
                class="shrink-0 text-amber-400"
                title={`${props.store.state.dirtyCount} changed files`}
              >
                {DIRTY_MARK}
                {props.store.state.dirtyCount}
              </span>
            </Show>
            <Show
              when={
                !props.compact &&
                (props.store.state.ahead > 0 || props.store.state.behind > 0)
              }
            >
              <span class="flex shrink-0 items-center">
                <Show when={props.store.state.ahead > 0}>
                  <span title="Commits to push">
                    ↑{props.store.state.ahead}
                  </span>
                </Show>
                <Show when={props.store.state.behind > 0}>
                  <span class="text-rose-400" title="Commits to pull">
                    ↓{props.store.state.behind}
                  </span>
                </Show>
              </span>
            </Show>
          </div>
        )}
      </Show>

      <DirectoryModal
        open={choosing()}
        store={props.store}
        onClose={() => {
          setChoosing(false);
        }}
      />
    </div>
  );
}

function Fitted(props: { readonly texts: readonly string[] }) {
  const [share, setShare] = createSignal(1);
  const widest = (): string => props.texts[0] ?? "";
  const columns = (): number => Math.floor(widest().length * share() + SLACK);

  let box!: HTMLSpanElement;
  let ghost!: HTMLSpanElement;
  const observer = new ResizeObserver(() => {
    const full = ghost.getBoundingClientRect().width;
    setShare(full > 0 ? box.getBoundingClientRect().width / full : 1);
  });
  onCleanup(() => {
    observer.disconnect();
  });

  return (
    <span
      ref={(element: HTMLSpanElement) => {
        box = element;
        observer.observe(element);
      }}
      class="relative min-w-0 overflow-hidden whitespace-pre"
    >
      {/* The chip is `max-w-max`, so measure a copy no cut touches, or the box
          shrinks onto its own ellipsis. `inline-block`: inline boxes go unobserved. */}
      <span
        ref={(element: HTMLSpanElement) => {
          ghost = element;
          observer.observe(element);
        }}
        aria-hidden="true"
        class="invisible inline-block"
      >
        {widest()}
      </span>
      <span class="absolute inset-0">{fit(props.texts, columns())}</span>
    </span>
  );
}

function createOffline(
  status: () => ConnectionStatus,
  graceMs: () => number
): () => boolean {
  const [offline, setOffline] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    () => status(),
    (state) => {
      clearTimeout(timer);
      timer = undefined;
      if (state !== "connecting" && state !== "reconnecting") {
        setOffline(false);
        return;
      }
      timer = setTimeout(() => {
        setOffline(true);
      }, graceMs());
    }
  );
  onCleanup(() => {
    clearTimeout(timer);
  });
  return offline;
}
