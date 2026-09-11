import { createMemo, createSignal, Show } from "solid-js";

import type { ToolDiffHunk } from "#core/shared/DiffLines";
import type { ViewBlock } from "#core/view/ViewBlock";
import type { ChangeStatus, ChangeSummary } from "#protocol/Diff";
import { createMediaQuery, DESKTOP } from "../ui/media";
import { Spinner } from "../ui/Spinner";
import { Blocks } from "../view/Blocks";
import type { FileState } from "./DiffStore";
import { SplitDiff } from "./SplitHunk";

const LETTERS = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
} as const satisfies Record<ChangeStatus, string>;

const LETTER_CLASSES = {
  added: "text-emerald-400",
  modified: "text-amber-400",
  deleted: "text-rose-400",
  renamed: "text-indigo-300",
  untracked: "text-neutral-400",
} as const satisfies Record<ChangeStatus, string>;

function directory(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut + 1);
}

function file(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** One changed file: what happened to it, and its hunks once a reader asks. */
export function FileRow(props: {
  readonly file: ChangeSummary;
  readonly state: FileState | undefined;
  readonly onExpand: () => void;
}) {
  const [open, setOpen] = createSignal(false);
  const desktop = createMediaQuery(DESKTOP);

  const hunks = createMemo<readonly ToolDiffHunk[]>(() => {
    const state = props.state;
    return state?.kind === "ready" &&
      !props.file.binary &&
      state.diff.hunks.length > 0
      ? state.diff.hunks
      : [];
  });

  const blocks = createMemo<readonly ViewBlock[]>(() =>
    hunks().length === 0
      ? []
      : [{ kind: "diff", path: props.file.path, hunks: hunks() }]
  );

  const toggle = (): void => {
    const next = !open();
    setOpen(next);
    if (next) {
      props.onExpand();
    }
  };

  return (
    <div class="border-b border-neutral-850 last:border-b-0">
      <button
        type="button"
        aria-expanded={open() ? "true" : "false"}
        aria-label={props.file.path}
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-neutral-900"
        onClick={toggle}
      >
        <span
          class={`i-griddy-icons:chevron-right-small-filled size-4 shrink-0 transition-transform ${open() ? "rotate-90" : ""}`}
          aria-hidden="true"
        />
        <span
          class={`w-3 shrink-0 font-bold ${LETTER_CLASSES[props.file.status]}`}
        >
          {LETTERS[props.file.status]}
        </span>
        <span class="min-w-0 flex-1 truncate">
          <Show when={props.file.oldPath}>
            {(from) => <span class="text-neutral-500">{from()} → </span>}
          </Show>
          <span class="text-neutral-500">{directory(props.file.path)}</span>
          <span class="text-neutral-100">{file(props.file.path)}</span>
        </span>
        <Show
          when={!props.file.binary}
          fallback={<span class="shrink-0 text-neutral-500">binary</span>}
        >
          <span class="flex shrink-0 gap-1.5 tabular-nums">
            <Show when={props.file.added > 0}>
              <span class="text-emerald-400">+{props.file.added}</span>
            </Show>
            <Show when={props.file.removed > 0}>
              <span class="text-rose-400">−{props.file.removed}</span>
            </Show>
          </span>
        </Show>
      </button>

      <Show when={open()}>
        <div class="px-3 pb-2 text-sm">
          <Show when={props.state?.kind === "loading"}>
            <span class="flex items-center gap-2 text-neutral-500">
              <Spinner />
              reading the diff
            </span>
          </Show>
          <Show when={props.state?.kind === "error" ? props.state : undefined}>
            {(failed) => (
              <p class="whitespace-pre-wrap text-rose-400">
                {failed().message}
              </p>
            )}
          </Show>
          <Show when={props.state?.kind === "ready"}>
            <Show
              when={hunks().length > 0}
              fallback={
                <p class="text-neutral-500">
                  {props.file.binary ? "binary file" : "no textual changes"}
                </p>
              }
            >
              <div class="overflow-x-auto">
                <Show when={desktop()} fallback={<Blocks blocks={blocks()} />}>
                  <SplitDiff path={props.file.path} hunks={hunks()} />
                </Show>
              </div>
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  );
}
