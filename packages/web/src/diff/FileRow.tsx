import { createEffect, createMemo, createSignal, Show } from "solid-js";

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

const UNITS = ["B", "kB", "MB", "GB"] as const;

function bytes(count: number): string {
  let size = count;
  let unit = 0;
  while (size >= 1000 && unit < UNITS.length - 1) {
    size /= 1000;
    unit += 1;
  }
  return `${unit === 0 ? size : size.toFixed(1)} ${UNITS[unit]}`;
}

/** One changed file: what happened to it, and its hunks once a reader asks. */
export function FileRow(props: {
  readonly file: ChangeSummary;
  readonly state: FileState | undefined;
  readonly seen: boolean;
  readonly onExpand: () => void;
  readonly onToggleSeen: () => void;
}) {
  const [open, setOpen] = createSignal(false);
  const desktop = createMediaQuery(DESKTOP);

  createEffect(
    () => props.seen,
    (seen) => {
      if (seen) {
        setOpen(false);
      }
    }
  );

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

  const ready = createMemo(() =>
    props.state?.kind === "ready" ? props.state.diff : undefined
  );

  const truncated = createMemo(() => ready()?.truncated === true);

  const binary = createMemo(() => {
    const diff = ready();
    const sizes = [diff?.oldBytes, diff?.newBytes]
      .filter((side) => side !== undefined)
      .map(bytes)
      .join(" → ");
    return sizes === "" ? "binary file" : `binary file ${sizes}`;
  });

  const toggle = (): void => {
    const next = !open();
    setOpen(next);
    if (next) {
      props.onExpand();
    }
  };

  return (
    <div class="border-b border-neutral-850 last:border-b-0">
      <div class="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-neutral-900">
        <button
          type="button"
          role="checkbox"
          aria-checked={props.seen ? "true" : "false"}
          aria-label={`Seen ${props.file.path}`}
          title="Reviewed"
          class="flex size-5 shrink-0 items-center justify-center rounded text-neutral-500 hover:text-neutral-100"
          onClick={props.onToggleSeen}
        >
          <span
            class={
              props.seen
                ? "i-griddy-icons:checkbox-filled size-4 text-indigo-400"
                : "i-griddy-icons:checkbox size-4"
            }
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          aria-expanded={open() ? "true" : "false"}
          aria-label={props.file.path}
          class={`flex min-w-0 flex-1 items-center gap-2 text-left ${props.seen ? "opacity-50" : ""}`}
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
      </div>

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
            <Show when={hunks().length > 0}>
              <div class="overflow-x-auto">
                <Show when={desktop()} fallback={<Blocks blocks={blocks()} />}>
                  <SplitDiff path={props.file.path} hunks={hunks()} />
                </Show>
              </div>
            </Show>
            <Show when={truncated()}>
              <p class="text-amber-400">
                diff is very large — the rest is not shown
              </p>
            </Show>
            <Show when={hunks().length === 0 && !truncated()}>
              <p class="text-neutral-500">
                {props.file.binary || ready()?.binary === true
                  ? binary()
                  : "no textual changes"}
              </p>
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  );
}
