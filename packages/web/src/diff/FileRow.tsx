import {
  createMemo,
  createSignal,
  For,
  Show,
  untrack,
  useContext,
  type Element,
} from "solid-js";

import type { ToolDiffHunk, ToolDiffLine } from "#core/shared/DiffLines";
import { DiffExpand, type DiffGap } from "#core/view/DiffExpand";
import type { ChangeSummary } from "#protocol/Diff";
import { QUIET } from "../ui/classes";
import { Spinner } from "../ui/Spinner";
import { diffSide } from "../view/Blocks";
import { CommentCard } from "./CommentCard";
import {
  ReviewComments,
  type CommentAnchor,
  type CommentSide,
} from "./Comments";
import type { FileState } from "./DiffStore";
import { FileLabel } from "./FileLabel";
import { Stat } from "./Stat";
import { SplitDiff } from "./SplitHunk";
import { UnifiedDiff } from "./UnifiedDiff";

const LEAD = "text-neutral-400";

const UNITS = ["B", "kB", "MB", "GB"] as const;

const NO_IDS: readonly string[] = [];

function bytes(count: number): string {
  let size = count;
  let unit = 0;
  while (size >= 1000 && unit < UNITS.length - 1) {
    size /= 1000;
    unit += 1;
  }
  return `${unit === 0 ? size : size.toFixed(1)} ${UNITS[unit]}`;
}

function numberOf(line: ToolDiffLine, side: CommentSide): number | undefined {
  return side === "old" ? line.oldLine : line.newLine;
}

/** One changed file: what happened to it, and its hunks once a reader asks. */
export function FileRow(props: {
  readonly file: ChangeSummary;
  readonly state: FileState | undefined;
  readonly onExpand: () => void;
  /** Reads the file's own lines behind one gap and shows them. */
  readonly onOpen: (gap: DiffGap) => void;
  /** Old beside new rather than one column of both, as the pane's width allows. */
  readonly split: boolean;
}) {
  const [open, setOpen] = createSignal(false);
  const comments = useContext(ReviewComments)();
  /** The comment a second tap on a gutter widens, rather than starting another. */
  const [writing, setWriting] = createSignal<{
    readonly id: string;
    readonly side?: CommentSide;
  }>();

  const ready = createMemo(() =>
    props.state?.kind === "ready" ? props.state.diff : undefined
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

  const badge = createMemo(() => comments?.count(props.file.path) ?? 0);

  // The cards are listed by id: a comment is a new object on every keystroke,
  // and a list of those would rebuild the box it was typed into.
  const card = (id: string): Element => (
    <Show when={comments?.one(id)}>
      {(held) => (
        <CommentCard
          comment={held()}
          outdated={held().fingerprint !== props.file.fingerprint}
          focus={id === untrack(writing)?.id}
          onWrite={(text) => {
            comments?.write(id, text);
          }}
          onRemove={() => {
            comments?.remove(id);
            setWriting((pending) => (pending?.id === id ? undefined : pending));
          }}
        />
      )}
    </Show>
  );

  // A handler reads the file rather than tracking it, and Solid asks to be told so.
  const anchorOf = (): CommentAnchor =>
    untrack(() => ({
      path: props.file.path,
      fingerprint: props.file.fingerprint,
    }));

  /** Opens a comment and keeps it, so the next tap widens it rather than starting another. */
  const start = (anchor: CommentAnchor): void => {
    const id = comments?.open(anchor);
    if (id !== undefined) {
      setWriting({ id, side: anchor.side });
    }
  };

  // A unified row belongs to the one side it has; a split column says which it is.
  const pick = (line: ToolDiffLine, side = diffSide(line)): void => {
    const number = numberOf(line, side);
    if (number === undefined) {
      return;
    }
    const pending = untrack(writing);
    if (pending !== undefined && pending.side === side) {
      comments?.extend(pending.id, number);
      setWriting(undefined);
      return;
    }
    start({ ...anchorOf(), side, line: number, quote: line.text });
  };

  const anchored = (line: ToolDiffLine, side = diffSide(line)): Element => {
    const number = numberOf(line, side);
    return (
      <For
        each={
          number === undefined
            ? NO_IDS
            : comments?.ids(props.file.path, side, number)
        }
      >
        {(id) => card(id)}
      </For>
    );
  };

  return (
    <div class="border-b border-neutral-850 last:border-b-0">
      {/* The title bar pins to the top of the list for as long as any of its
          file is still on screen, so a long diff is never read with nothing
          saying which file it is. Pinned means opaque — the next row's bar
          slides over this one as it leaves, and two transparent bars would be
          legible through each other. `z-1` because being positioned is not
          enough: an icon is a masked element, which is a stacking context of
          its own painted in the same pass as this bar, so every icon below
          would show through it. The layer stays inside the list, which
          isolates it from the composer floating at the foot.

          An open file's bar is lit, and stays exactly that lit under a
          pointer: it is already the row being read, so there is nothing left
          for a hover to say. A closed row's hover stops one step short of it,
          so a row you are merely pointing at never passes for the open one.
          Only the bar — the hunks below stay on the page, or the lit block
          would be the file rather than its handle. */}
      {/* The button stretches the full height of the bar, so the whole row
          answers a click rather than the line of text in the middle of it. */}
      <div
        class={`sticky top-0 z-1 flex w-full items-center gap-2 px-3 text-sm ${open() ? "bg-neutral-850" : "bg-neutral-925 hover:bg-neutral-900"}`}
      >
        <button
          type="button"
          aria-expanded={open() ? "true" : "false"}
          aria-label={props.file.path}
          class="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
          onClick={toggle}
        >
          <span
            class={`i-griddy-icons:chevron-right-small-filled size-4 shrink-0 text-neutral-400 transition-transform ${open() ? "rotate-90" : ""}`}
            aria-hidden="true"
          />
          <FileLabel file={props.file} />
          <Show when={badge() > 0}>
            <span class="flex shrink-0 items-center gap-1 text-neutral-400 tabular-nums">
              <span
                class="i-griddy-icons:chat-bubble-dots size-4"
                aria-hidden="true"
              />
              {badge()}
            </span>
          </Show>
          <Show
            when={!props.file.binary}
            fallback={<span class={`shrink-0 ${LEAD}`}>binary</span>}
          >
            <Stat added={props.file.added} removed={props.file.removed} />
          </Show>
        </button>
      </div>

      <Show when={open()}>
        <div class="px-3 pb-2 text-sm">
          <Show when={comments !== undefined}>
            <button
              type="button"
              class={`${QUIET} my-1 flex items-center gap-1.5`}
              onClick={() => {
                start(anchorOf());
              }}
            >
              <span
                class="i-griddy-icons:chat-bubble-dots size-4 shrink-0"
                aria-hidden="true"
              />
              add comment
            </button>
            <For each={comments?.ids(props.file.path) ?? NO_IDS}>
              {(id) => card(id)}
            </For>
          </Show>
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
                    onPickLine={comments === undefined ? undefined : pick}
                    after={comments === undefined ? undefined : anchored}
                  />
                }
              >
                <SplitDiff
                  path={props.file.path}
                  hunks={hunks()}
                  total={ready()?.total}
                  busy={opening()}
                  onOpen={props.onOpen}
                  onPickLine={comments === undefined ? undefined : pick}
                  after={comments === undefined ? undefined : anchored}
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
