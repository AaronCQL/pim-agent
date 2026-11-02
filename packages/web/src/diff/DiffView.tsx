import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  untrack,
} from "solid-js";

import type { Settings } from "../settings/Settings";
import { ACTION, ICON, QUIET } from "../ui/classes";
import { Fade } from "../ui/Fade";
import { Menu, type MenuOption } from "../ui/Menu";
import { observeWidth } from "../ui/scroll";
import { CommitModal } from "./CommitModal";
import { DiffStore, type BaseKind } from "./DiffStore";
import { FileRow } from "./FileRow";
import { ModeSwitch, type ReviewMode } from "./ModeSwitch";
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

function labelOf(options: readonly MenuOption[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

/** Rows painted per page. */
const PAGE = 500;

export function DiffView(props: {
  readonly diff: DiffStore;
  readonly settings: Settings;
  /** Height of the composer overlaying the bottom, in px. */
  readonly inset: number;
  readonly mode: ReviewMode;
  readonly onMode: (mode: ReviewMode) => void;
  /** Opens a file in the file viewer. */
  readonly onView: (path: string) => void;
  /** A file to scroll to once it is listed. */
  readonly focus: string | undefined;
  readonly onFocused: () => void;
  readonly onClose: () => void;
}) {
  const [visible, setVisible] = createSignal(PAGE);
  const [width, setWidth] = createSignal(0);
  const [writing, setWriting] = createSignal(false);
  let scroller!: HTMLDivElement;
  const measure = observeWidth(setWidth);

  const split = createMemo(() =>
    SplitMode.split(props.settings.state.diffSplit, width())
  );

  props.diff.watch(true);
  onCleanup(() => {
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

  createEffect(
    () => props.diff.files(),
    () => {
      setVisible(PAGE);
    }
  );

  const shown = createMemo(() => props.diff.files().slice(0, visible()));

  /** A focused row waiting for its hunks before it is scrolled to. */
  const [landing, setLanding] = createSignal<string>();

  createEffect(
    () => ({ path: props.focus, files: props.diff.files() }),
    ({ path, files }) => {
      const at =
        path === undefined ? -1 : files.findIndex((file) => file.path === path);
      if (path === undefined || at < 0) {
        return;
      }
      setVisible((rows) => Math.max(rows, at + 1));
      setLanding(path);
      props.onFocused();
    }
  );

  createEffect(
    () => {
      const path = landing();
      return path === undefined
        ? undefined
        : { path, kind: props.diff.fileState(path)?.kind };
    },
    (target) => {
      if (target === undefined || target.kind === "loading") {
        return;
      }
      setLanding(undefined);
      requestAnimationFrame(() => {
        for (const row of scroller.querySelectorAll<HTMLElement>(
          "[data-path]"
        )) {
          if (row.dataset.path === target.path) {
            row.scrollIntoView({ block: "start" });
          }
        }
      });
    }
  );

  const all = createMemo(() => props.diff.files().length);

  // Only a failed commit keeps the modal open.
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
          <ModeSwitch mode={props.mode} onMode={props.onMode} />
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
        <Show when={props.diff.state.committed}>
          {(sha) => (
            <div class="px-3 pb-2 text-sm text-emerald-400">
              committed {sha()}
            </div>
          )}
        </Show>
      </header>

      <div
        ref={(element: HTMLDivElement) => {
          scroller = element;
          measure(element);
        }}
        class="isolate min-h-0 flex-1 overflow-y-auto"
      >
        <div style={{ "padding-bottom": `${props.inset}px` }}>
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
              all() === 0
            }
          >
            <p class="px-3 py-2 text-sm text-neutral-400">
              Nothing has changed.
            </p>
          </Show>
          <For each={shown()} keyed={(file) => file.path}>
            {(file) => (
              <FileRow
                file={file()}
                state={props.diff.fileState(file().path)}
                open={props.diff.isOpen(file().path)}
                split={split()}
                onToggle={() => {
                  props.diff.toggle(file().path);
                }}
                onOpen={(gap) => {
                  void props.diff.open(file().path, gap);
                }}
                onView={() => {
                  props.onView(file().path);
                }}
              />
            )}
          </For>
          <Show when={all() > shown().length}>
            <div class="flex items-center gap-2 px-3 py-2 text-sm text-neutral-400">
              <span class="tabular-nums">
                {shown().length} of {all()}
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
        <Fade height={props.inset} />
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
