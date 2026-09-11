import { createEffect, createMemo, createSignal, For, Show } from "solid-js";

import type { SessionStore } from "../session/SessionStore";
import { QUIET } from "../ui/classes";
import { Menu, type MenuOption } from "../ui/Menu";
import { Modal } from "../ui/Modal";
import { DiffStore, type BaseKind } from "./DiffStore";
import { FileRow } from "./FileRow";
import { Seen } from "./Seen";

const BASES = [
  { value: "worktree", label: "worktree", tag: "everything uncommitted" },
  { value: "unstaged", label: "unstaged", tag: "worktree vs index" },
  { value: "staged", label: "staged", tag: "index vs HEAD" },
] as const satisfies readonly MenuOption[];

/** How many rows are painted at once; the next page is a button, never a scroll handler. */
const PAGE = 500;

/** Every file the chosen base says has changed, each opening onto its hunks. */
export function DiffOverlay(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly store: SessionStore;
}) {
  const diff = new DiffStore(props.store);
  const seen = new Seen();
  const [visible, setVisible] = createSignal(PAGE);

  createEffect(
    () => props.open,
    (open) => {
      if (open) {
        void diff.refresh();
      }
    }
  );

  createEffect(
    () => props.store.state.dirtyCount,
    (count, previous) => {
      if (previous !== undefined && count !== previous) {
        diff.markStale();
      }
    }
  );

  createEffect(
    () => diff.files(),
    () => {
      setVisible(PAGE);
    }
  );

  createEffect(
    () => ({
      cwd: props.store.state.cwd,
      files: diff.files(),
      // A list nobody has read yet is not a working copy with nothing in it.
      read: diff.state.status === "ready" && diff.state.error === undefined,
    }),
    ({ cwd, files, read }) => {
      if (read) {
        seen.load(cwd, files);
      }
    }
  );

  const shown = createMemo(() => diff.files().slice(0, visible()));

  const count = (): string => {
    const files = diff.files().length;
    return `${files} ${files === 1 ? "file" : "files"}`;
  };

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      label="Changes"
      header={
        <div class="flex min-w-0 flex-col gap-1.5">
          <div class="flex min-w-0 items-center gap-3">
            <span class="shrink-0 font-bold leading-[--line]">Changes</span>
            <Menu
              label={diff.state.base}
              icon="i-griddy-icons:code-compare"
              options={BASES}
              value={diff.state.base}
              title="What the changes are measured against"
              onSelect={(value) => {
                diff.setBase(value as BaseKind);
              }}
            />
            <span class="ml-auto flex shrink-0 items-center gap-2 text-sm text-neutral-400 tabular-nums">
              {count()}
              <Show when={diff.state.added > 0}>
                <span class="text-emerald-400">+{diff.state.added}</span>
              </Show>
              <Show when={diff.state.removed > 0}>
                <span class="text-rose-400">−{diff.state.removed}</span>
              </Show>
            </span>
          </div>
          <Show when={diff.files().length > 0}>
            <div class="flex min-w-0 flex-wrap items-center gap-2 text-sm text-neutral-400">
              <span class="tabular-nums">
                {seen.count()} of {diff.files().length} reviewed
              </span>
              <button
                type="button"
                class={`${QUIET} ml-auto`}
                onClick={() => {
                  seen.markAll(diff.files());
                }}
              >
                mark all seen
              </button>
              <button
                type="button"
                class={QUIET}
                onClick={() => {
                  seen.clear();
                }}
              >
                clear
              </button>
            </div>
          </Show>
          <Show when={diff.state.stale}>
            <div class="flex min-w-0 items-center gap-2 text-sm text-amber-400">
              <span>The repository has changed since this was read.</span>
              <button
                type="button"
                class={`${QUIET} ml-auto flex items-center gap-1.5`}
                title="Read the change list again"
                onClick={() => {
                  void diff.refresh();
                }}
              >
                <span
                  class="i-griddy-icons:refresh size-4 shrink-0"
                  aria-hidden="true"
                />
                refresh
              </button>
            </div>
          </Show>
        </div>
      }
    >
      <Show when={props.open}>
        <div class="min-h-0 flex-1 overflow-y-auto">
          <Show when={diff.state.error}>
            {(message) => (
              <p class="px-3 py-2 text-sm whitespace-pre-wrap text-rose-400">
                {message()}
              </p>
            )}
          </Show>
          <Show
            when={
              diff.state.error === undefined &&
              diff.state.status === "ready" &&
              diff.files().length === 0
            }
          >
            <p class="px-3 py-2 text-sm text-neutral-500">
              Nothing has changed.
            </p>
          </Show>
          <For each={shown()}>
            {(file) => (
              <FileRow
                file={file}
                state={diff.fileState(file.path)}
                seen={seen.isSeen(file)}
                onExpand={() => {
                  void diff.expand(file.path);
                }}
                onToggleSeen={() => {
                  seen.toggle(file);
                }}
              />
            )}
          </For>
          <Show when={diff.files().length > shown().length}>
            <div class="flex items-center gap-2 px-3 py-2 text-sm text-neutral-400">
              <span class="tabular-nums">
                {shown().length} of {diff.files().length}
              </span>
              <button
                type="button"
                class={`${QUIET} ml-auto`}
                onClick={() => {
                  setVisible((rows) => rows + PAGE);
                }}
              >
                show more
              </button>
            </div>
          </Show>
          <Show when={diff.state.truncated}>
            <p class="px-3 py-2 text-sm text-amber-400">
              More files changed than this list holds.
            </p>
          </Show>
        </div>
      </Show>
    </Modal>
  );
}
