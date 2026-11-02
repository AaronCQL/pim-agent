import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
  untrack,
} from "solid-js";

import type { DiffStore } from "../diff/DiffStore";
import { ModeSwitch, type ReviewMode } from "../diff/ModeSwitch";
import { ICON } from "../ui/classes";
import { createMediaQuery, DESKTOP } from "../ui/media";
import type { FileStore } from "./FileStore";
import { FileTreeView } from "./FileTreeView";
import { FileViewer } from "./FileViewer";

export function FilesView(props: {
  readonly files: FileStore;
  readonly diff: DiffStore;
  /** Height of the composer overlaying the bottom, in px. */
  readonly inset: number;
  readonly mode: ReviewMode;
  readonly onMode: (mode: ReviewMode) => void;
  readonly onDiff: (path: string) => void;
  readonly onClose: () => void;
}) {
  const wide = createMediaQuery(DESKTOP);
  /** On a narrow screen, the tree and the file take turns. */
  const [browsing, setBrowsing] = createSignal(
    untrack(() => props.files.state.selected === undefined)
  );

  props.files.watch(true);
  props.diff.watch(true);
  onCleanup(() => {
    props.files.watch(false);
    props.diff.watch(false);
  });

  createEffect(
    () => props.diff.state.status,
    (status) => {
      if (status === "idle") {
        void props.diff.refresh();
      }
    }
  );

  const changes = createMemo(
    () => new Map(props.diff.files().map((file) => [file.path, file]))
  );

  const reading = (): boolean =>
    !wide() && !browsing() && props.files.state.selected !== undefined;

  return (
    <section aria-label="Files" class="flex h-full min-h-0 flex-col">
      <header class="flex h-12 min-w-0 shrink-0 items-center gap-2 border-b border-neutral-700 px-3">
        <button
          type="button"
          aria-label={
            reading() ? "Back to the files" : "Back to the conversation"
          }
          class={ICON}
          onClick={() => {
            if (reading()) {
              setBrowsing(true);
            } else {
              props.onClose();
            }
          }}
        >
          <span class="i-griddy-icons:arrow-left size-5" aria-hidden="true" />
        </button>
        <ModeSwitch mode={props.mode} onMode={props.onMode} />
      </header>
      <div class="flex min-h-0 flex-1">
        <Show when={wide() || !reading()}>
          <div
            class={`min-h-0 ${wide() ? "w-72 shrink-0 border-r border-neutral-800" : "flex-1"}`}
          >
            <FileTreeView
              files={props.files}
              changes={changes()}
              inset={props.inset}
              onPick={(path) => {
                props.files.select(path);
                setBrowsing(false);
              }}
            />
          </div>
        </Show>
        <Show when={wide() || reading()}>
          <div class="min-h-0 min-w-0 flex-1">
            <FileViewer
              files={props.files}
              change={
                props.files.state.selected === undefined
                  ? undefined
                  : changes().get(props.files.state.selected)
              }
              inset={props.inset}
              onDiff={props.onDiff}
            />
          </div>
        </Show>
      </div>
    </section>
  );
}
