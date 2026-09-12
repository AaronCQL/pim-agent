import { createEffect, createSignal, onCleanup, Show } from "solid-js";

import { abbreviateHome, baseName } from "../format";
import type { SessionStore } from "../session/SessionStore";
import type { ConnectionStatus } from "../ws/WsClient";
import { CHIP_BUTTON, CHIP_GROUP, CHIP_SEGMENT } from "../ui/classes";
import { Fitted } from "../ui/Fitted";
import { BranchMenu } from "./BranchMenu";
import { DirectoryModal } from "./DirectoryModal";

const GRACE_MS = 1500;

function changesLabel(count: number, reviewing: boolean): string {
  if (reviewing) {
    return "Back to the conversation";
  }
  if (count === 0) {
    return "Review changes, working tree clean";
  }
  return `Review changes, ${count} changed file${count === 1 ? "" : "s"}`;
}

/** The row above the transcript: where the session is, and what its repository is doing. */
export function Topbar(props: {
  readonly store: SessionStore;
  readonly compact: boolean;
  readonly reviewing: boolean;
  readonly onToggleSidebar: () => void;
  readonly onToggleDiff: () => void;
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
            class={CHIP_BUTTON}
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
          <div class={CHIP_GROUP}>
            <BranchMenu
              store={props.store}
              branch={branch()}
              compact={props.compact}
            />
            <button
              type="button"
              aria-pressed={props.reviewing ? "true" : "false"}
              class={`${CHIP_SEGMENT} shrink-0 rounded-r-lg border-l border-neutral-750`}
              aria-label={changesLabel(
                props.store.state.dirtyCount,
                props.reviewing
              )}
              title={changesLabel(
                props.store.state.dirtyCount,
                props.reviewing
              )}
              onClick={props.onToggleDiff}
            >
              <span
                class={`i-griddy-icons:file-edit size-4 shrink-0 ${
                  props.store.state.dirtyCount > 0 ? "text-amber-400" : ""
                }`}
              />
              <Show when={props.store.state.dirtyCount > 0}>
                <span class="shrink-0 text-amber-400">
                  {props.store.state.dirtyCount}
                </span>
              </Show>
            </button>
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
