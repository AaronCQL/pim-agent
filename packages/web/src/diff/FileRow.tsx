import { createEffect, createMemo, createSignal, For, Show } from "solid-js";

import type { ToolDiffHunk } from "#core/shared/DiffLines";
import { DiffExpand, type DiffGap } from "#core/view/DiffExpand";
import type { ChangeStatus, ChangeSummary } from "#protocol/Diff";
import { Fitted } from "../ui/Fitted";
import { Spinner } from "../ui/Spinner";
import type { FileState } from "./DiffStore";
import { FileTitle, type Role } from "./FileTitle";
import { SplitDiff } from "./SplitHunk";
import { UnifiedDiff } from "./UnifiedDiff";

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

/** What leads to the name, the name itself, and the half of a move that is
    gone — struck exactly as the patch tool strikes it. */
const LEAD = "text-neutral-400";
const ROLES = {
  lead: LEAD,
  name: "text-neutral-100",
  gone: `${LEAD} line-through`,
} as const satisfies Record<Role, string>;

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
  /** Reads the file's own lines behind one gap and shows them. */
  readonly onOpen: (gap: DiffGap) => void;
  /** Old beside new rather than one column of both, as the pane's width allows. */
  readonly split: boolean;
}) {
  const [open, setOpen] = createSignal(false);

  createEffect(
    () => props.seen,
    (seen) => {
      if (seen) {
        setOpen(false);
      }
    }
  );

  const ready = createMemo(() =>
    props.state?.kind === "ready" ? props.state.diff : undefined
  );

  const readings = createMemo(() =>
    FileTitle.readings(props.file.path, props.file.oldPath)
  );

  const hunks = createMemo<readonly ToolDiffHunk[]>(() => {
    const state = props.state;
    return state?.kind === "ready" &&
      !props.file.binary &&
      state.diff.hunks.length > 0
      ? DiffExpand.expand(state.diff.hunks, state.lines)
      : [];
  });

  const truncated = createMemo(() => ready()?.truncated === true);

  const opening = createMemo(
    () => props.state?.kind === "ready" && props.state.opening
  );

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
      {/* The title bar pins to the top of the list for as long as any of its
          file is still on screen, so a long diff is never read with nothing
          saying which file it is. Pinned means opaque — the next row's bar
          slides over this one as it leaves, and two transparent bars would be
          legible through each other. No `z-`: being positioned is already
          enough to cover the hunks it scrolls over, and a layer of its own
          would lift the bar over the composer floating at the foot.

          An open file's bar is lit, and stays exactly that lit under a
          pointer: it is already the row being read, so there is nothing left
          for a hover to say. A closed row's hover stops one step short of it,
          so a row you are merely pointing at never passes for the open one.
          Only the bar — the hunks below stay on the page, or the lit block
          would be the file rather than its handle. */}
      {/* The bar carries no padding of its own: the expand button does, so the
          whole height of the row answers a click rather than the line of text
          in the middle of it. */}
      <div
        class={`sticky top-0 flex w-full items-center gap-2 pl-3 text-sm ${open() ? "bg-neutral-850" : "bg-neutral-925 hover:bg-neutral-900"}`}
      >
        <button
          type="button"
          role="checkbox"
          aria-checked={props.seen ? "true" : "false"}
          aria-label={`Seen ${props.file.path}`}
          title="Reviewed"
          class="flex w-5 shrink-0 items-center justify-center self-stretch rounded text-neutral-500 hover:text-neutral-100"
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
          class={`flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-3 text-left ${props.seen ? "opacity-50" : ""}`}
          onClick={toggle}
        >
          <span
            class={`i-griddy-icons:chevron-right-small-filled size-4 shrink-0 text-neutral-400 transition-transform ${open() ? "rotate-90" : ""}`}
            aria-hidden="true"
          />
          <span
            class={`w-3 shrink-0 font-bold ${LETTER_CLASSES[props.file.status]}`}
          >
            {LETTERS[props.file.status]}
          </span>
          <Fitted class="flex-1" texts={[FileTitle.widest(readings())]}>
            {(columns) => (
              <For each={FileTitle.fit(readings(), columns)}>
                {(piece) => <span class={ROLES[piece.role]}>{piece.text}</span>}
              </For>
            )}
          </Fitted>
          <Show
            when={!props.file.binary}
            fallback={<span class={`shrink-0 ${LEAD}`}>binary</span>}
          >
            {/* `+12/−3`, the stat a diff tool's own title carries: the slash
                binds the two counts into one reading, so neither is mistaken
                for a number belonging to something else on the bar. */}
            <span class="flex shrink-0 tabular-nums">
              <Show when={props.file.added > 0}>
                <span class="text-emerald-400">+{props.file.added}</span>
              </Show>
              <Show when={props.file.added > 0 && props.file.removed > 0}>
                <span class="text-neutral-600">/</span>
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
            <span class={`flex items-center gap-2 ${LEAD}`}>
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
              <Show
                when={props.split}
                fallback={
                  <UnifiedDiff
                    path={props.file.path}
                    hunks={hunks()}
                    total={ready()?.total}
                    busy={opening()}
                    onOpen={props.onOpen}
                  />
                }
              >
                <SplitDiff
                  path={props.file.path}
                  hunks={hunks()}
                  total={ready()?.total}
                  busy={opening()}
                  onOpen={props.onOpen}
                />
              </Show>
            </Show>
            <Show
              when={
                props.state?.kind === "ready" ? props.state.failed : undefined
              }
            >
              {(message) => (
                <p class="whitespace-pre-wrap text-rose-400">{message()}</p>
              )}
            </Show>
            <Show when={truncated()}>
              <p class="text-amber-400">
                diff is very large — the rest is not shown
              </p>
            </Show>
            <Show when={hunks().length === 0 && !truncated()}>
              <p class={LEAD}>
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
