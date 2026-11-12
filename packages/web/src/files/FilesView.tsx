import { createEffect, createMemo, onCleanup, onSettled, Show } from "solid-js";

import type { ChangeSummary } from "#protocol/Diff";
import { CommitActions } from "../diff/CommitActions";
import type { DiffStore } from "../diff/DiffStore";
import { ModeSwitch, type ReviewMode } from "../diff/ModeSwitch";
import { CHIP_BUTTON, ICON } from "../ui/classes";
import { createMediaQuery, DESKTOP } from "../ui/media";
import { ChangeMarks, type ChangeMarkMap } from "../view/ChangeMarks";
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

  onSettled(() => {
    props.files.watch(true);
    props.diff.watch(true);
  });
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

  const change = createMemo(() => {
    const path = props.files.state.selected;
    return path === undefined ? undefined : changes().get(path);
  });

  const marked = (): ChangeSummary | undefined => {
    const summary = change();
    return summary === undefined ||
      summary.binary === true ||
      summary.status === "deleted" ||
      props.diff.state.base === "staged"
      ? undefined
      : summary;
  };

  const whole = (summary: ChangeSummary): boolean =>
    summary.status === "added" || summary.status === "untracked";

  createEffect(
    () => {
      const summary = marked();
      return summary === undefined || whole(summary) ? undefined : summary;
    },
    (summary) => {
      if (summary !== undefined) {
        void props.diff.expand(summary.path);
      }
    }
  );

  const marks = createMemo((): ChangeMarkMap | undefined => {
    const summary = marked();
    const view = props.files.view();
    if (summary === undefined || view?.kind !== "ready") {
      return undefined;
    }
    if (whole(summary)) {
      return ChangeMarks.whole(view.lines.length);
    }
    const state = props.diff.fileState(summary.path);
    return state?.kind === "ready"
      ? ChangeMarks.of(state.diff.hunks, view.lines.length)
      : undefined;
  });

  const picking = (): boolean =>
    wide() || props.files.state.selected === undefined;

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
        <Show when={!wide()}>
          <button
            type="button"
            class={CHIP_BUTTON}
            aria-label="Browse"
            onClick={() => {
              props.files.select(undefined);
            }}
          >
            <span
              class="i-griddy-icons:folders size-4 shrink-0"
              aria-hidden="true"
            />
            Browse
          </button>
        </Show>
        <CommitActions diff={props.diff} />
      </header>
      <div class="flex min-h-0 flex-1">
        <Show when={picking()}>
          <div
            class={`min-h-0 ${wide() ? "w-72 shrink-0 border-r border-neutral-800" : "flex-1"}`}
          >
            <FileTreeView
              files={props.files}
              changes={changes()}
              inset={props.inset}
              onPick={(path) => props.files.select(path)}
            />
          </div>
        </Show>
        <Show when={wide() || !picking()}>
          <div class="min-h-0 min-w-0 flex-1">
            <FileViewer
              files={props.files}
              change={change()}
              marks={marks()}
              inset={props.inset}
              onDiff={props.onDiff}
            />
          </div>
        </Show>
      </div>
    </section>
  );
}
