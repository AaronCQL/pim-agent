import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  untrack,
} from "solid-js";

import type { Settings } from "../settings/Settings";
import { ACTION, ICON, QUIET } from "../ui/classes";
import { Menu, type MenuOption } from "../ui/Menu";
import { observeWidth } from "../ui/scroll";
import { CommitModal } from "./CommitModal";
import { DiffStore, type BaseKind } from "./DiffStore";
import { FileRow } from "./FileRow";
import { SplitMode } from "./SplitMode";
import { Stat } from "./Stat";

const BASES = [
  { value: "worktree", label: "Worktree" },
  { value: "unstaged", label: "Unstaged" },
  { value: "staged", label: "Staged" },
] as const satisfies readonly MenuOption[];

const LAYOUTS = [
  { value: "auto", label: "Auto" },
  { value: "split", label: "Split" },
  { value: "unified", label: "Unified" },
] as const satisfies readonly MenuOption[];

/** The chip wears the chosen row's own label rather than the value stored behind it. */
function labelOf(options: readonly MenuOption[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

/** How many rows are painted at once; the next page is a button, never a scroll handler. */
const PAGE = 500;

/** Every file the chosen base says has changed, each opening onto its hunks. */
export function DiffView(props: {
  readonly diff: DiffStore;
  readonly settings: Settings;
  /** What the composer floating over the foot covers, so the last row clears it. */
  readonly inset: number;
  readonly onClose: () => void;
}) {
  const [visible, setVisible] = createSignal(PAGE);
  const [width, setWidth] = createSignal(0);
  const [writing, setWriting] = createSignal(false);
  const measure = observeWidth(setWidth);

  const split = createMemo(() =>
    SplitMode.split(props.settings.state.diffSplit, width())
  );

  createEffect(
    () => props.diff.state.status,
    (status) => {
      if (status === "idle") {
        void props.diff.refresh();
      }
    }
  );

  createEffect(
    () => props.diff.files(),
    () => {
      setVisible(PAGE);
    }
  );

  const shown = createMemo(() => props.diff.files().slice(0, visible()));

  const all = createMemo(() => props.diff.files().length);

  // The receipt is read back in the pane the commit emptied, so the modal is
  // only kept open by a refusal.
  const commit = (paths: readonly string[]): void => {
    void props.diff.commit(paths).then(() => {
      if (untrack(() => props.diff.state.failure) === undefined) {
        setWriting(false);
      }
    });
  };

  return (
    <section aria-label="Changes" class="flex h-full min-h-0 flex-col">
      <header class="flex shrink-0 flex-col border-b border-neutral-700">
        <div class="flex h-12 min-w-0 shrink-0 items-center gap-2 px-3">
          <button
            type="button"
            aria-label="Back to the conversation"
            class={ICON}
            onClick={props.onClose}
          >
            <span class="i-griddy-icons:arrow-left size-5" aria-hidden="true" />
          </button>
          <Menu
            label={labelOf(BASES, props.diff.state.base)}
            icon="i-griddy-icons:code-compare"
            options={BASES}
            value={props.diff.state.base}
            title="What the changes are measured against"
            shape="chip"
            place="below"
            onSelect={(value) => {
              props.diff.setBase(value as BaseKind);
            }}
          />
          <div class="hidden sm:block">
            <Menu
              label={labelOf(LAYOUTS, props.settings.state.diffSplit)}
              icon="i-griddy-icons:columns-two"
              options={LAYOUTS}
              value={props.settings.state.diffSplit}
              title="How each file's hunks are laid out"
              shape="chip"
              place="below"
              onSelect={(value) => {
                props.settings.setDiffSplit(SplitMode.parse(value));
              }}
            />
          </div>
          <div class="ml-auto flex shrink-0 items-center gap-2">
            <Stat
              added={props.diff.state.added}
              removed={props.diff.state.removed}
            />
            <Show when={all() > 0}>
              <button
                type="button"
                class={ACTION}
                title="Write a commit from these changes"
                onClick={() => {
                  props.diff.forgetCommit();
                  setWriting(true);
                }}
              >
                Commit
              </button>
            </Show>
          </div>
        </div>
        <Show when={props.diff.state.stale}>
          <div class="flex min-w-0 items-center gap-2 px-3 pb-2 text-sm text-amber-400">
            <span>The repository has changed since this was read.</span>
            <button
              type="button"
              class={`${QUIET} ml-auto flex items-center gap-1.5`}
              title="Read the change list again"
              onClick={() => {
                void props.diff.refresh();
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
        <Show when={props.diff.state.committed}>
          {(sha) => (
            <div class="px-3 pb-2 text-sm text-emerald-400">
              committed {sha()}
            </div>
          )}
        </Show>
      </header>

      {/* Isolated: the file bars inside stack against each other and the hunks
          they scroll over, and never against the composer floating over the
          foot of the same pane. */}
      <div
        ref={measure}
        class="isolate min-h-0 flex-1 overflow-y-auto"
        style={{ "padding-bottom": `${props.inset}px` }}
      >
        <Show when={props.diff.state.error}>
          {(message) => (
            <p class="px-3 py-2 text-sm whitespace-pre-wrap text-rose-400">
              {message()}
            </p>
          )}
        </Show>
        <Show
          when={
            props.diff.state.error === undefined &&
            props.diff.state.status === "ready" &&
            props.diff.files().length === 0
          }
        >
          <p class="px-3 py-2 text-sm text-neutral-400">Nothing has changed.</p>
        </Show>
        <For each={shown()}>
          {(file) => (
            <FileRow
              file={file}
              state={props.diff.fileState(file.path)}
              split={split()}
              onExpand={() => {
                void props.diff.expand(file.path);
              }}
              onOpen={(gap) => {
                void props.diff.open(file.path, gap);
              }}
            />
          )}
        </For>
        <Show when={props.diff.files().length > shown().length}>
          <div class="flex items-center gap-2 px-3 py-2 text-sm text-neutral-400">
            <span class="tabular-nums">
              {shown().length} of {props.diff.files().length}
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
        <Show when={props.diff.state.truncated}>
          <p class="px-3 py-2 text-sm text-amber-400">
            More files changed than this list holds.
          </p>
        </Show>
      </div>

      <CommitModal
        open={writing()}
        files={props.diff.files()}
        message={props.diff.state.message}
        committing={props.diff.state.committing}
        failure={props.diff.state.failure}
        onClose={() => {
          setWriting(false);
        }}
        onMessage={(message) => {
          props.diff.setMessage(message);
        }}
        onCommit={commit}
      />
    </section>
  );
}
