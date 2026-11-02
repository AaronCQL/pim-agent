import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";

import type { DiffStore } from "../diff/DiffStore";
import { ModeSwitch, type ReviewMode } from "../diff/ModeSwitch";
import { ICON } from "../ui/classes";
import { Drawer } from "../ui/Drawer";
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
  const [browsing, setBrowsing] = createSignal(false);

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

  const picking = (): boolean =>
    wide() || props.files.state.selected === undefined;

  const pick = (path: string): void => {
    props.files.select(path);
    setBrowsing(false);
  };

  const tree = (inset: number) => (
    <FileTreeView
      files={props.files}
      changes={changes()}
      inset={inset}
      onPick={pick}
    />
  );

  return (
    <section aria-label="Files" class="flex h-full min-h-0 flex-col">
      <header class="flex h-12 min-w-0 shrink-0 items-center gap-2 border-b border-neutral-700 px-3">
        <button
          type="button"
          aria-label="Back to the conversation"
          class={ICON}
          onClick={props.onClose}
        >
          <span class="i-griddy-icons:arrow-left size-5" aria-hidden="true" />
        </button>
        <ModeSwitch mode={props.mode} onMode={props.onMode} />
      </header>
      <div class="flex min-h-0 flex-1">
        <Show
          when={picking()}
          fallback={
            <Drawer
              open={browsing()}
              label="Files"
              onClose={() => {
                setBrowsing(false);
              }}
            >
              <Show when={browsing()}>{tree(0)}</Show>
            </Drawer>
          }
        >
          <div
            class={`min-h-0 ${wide() ? "w-72 shrink-0 border-r border-neutral-800" : "flex-1"}`}
          >
            {tree(props.inset)}
          </div>
        </Show>
        <Show when={wide() || !picking()}>
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
              {...(wide()
                ? {}
                : {
                    onBrowse: () => {
                      setBrowsing(true);
                    },
                  })}
            />
          </div>
        </Show>
      </div>
    </section>
  );
}
