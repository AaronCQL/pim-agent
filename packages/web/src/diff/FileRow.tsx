import {
  createEffect,
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
import type { ChangeStatus, ChangeSummary } from "#protocol/Diff";
import { Fitted } from "../ui/Fitted";
import { QUIET } from "../ui/classes";
import { Spinner } from "../ui/Spinner";
import { diffSide } from "../view/Blocks";
import { CommentCard } from "./CommentCard";
import {
  ReviewComments,
  type Comment,
  type CommentAnchor,
  type CommentSide,
} from "./Comments";
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

function numberOf(line: ToolDiffLine, side: CommentSide): number | undefined {
  return side === "old" ? line.oldLine : line.newLine;
}

/** One changed file: what happened to it, and its hunks once a reader asks. */
export function FileRow(props: {
  readonly file: ChangeSummary;
  readonly state: FileState | undefined;
  readonly picked: boolean;
  readonly onExpand: () => void;
  readonly onTogglePicked: () => void;
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

  createEffect(
    () => props.picked,
    (picked) => {
      if (picked) {
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

  const badge = createMemo(() => comments?.count(props.file.path) ?? 0);

  const fileComments = createMemo<readonly Comment[]>(() =>
    comments === undefined
      ? []
      : comments
          .list(props.file.path)
          .filter((comment) => comment.start === undefined)
  );

  const card = (comment: Comment): Element => (
    <CommentCard
      comment={comment}
      outdated={comment.fingerprint !== props.file.fingerprint}
      focus={comment.id === untrack(writing)?.id}
      onWrite={(text) => {
        comments?.write(comment.id, text);
      }}
      onRemove={() => {
        comments?.remove(comment.id);
        setWriting((held) => (held?.id === comment.id ? undefined : held));
      }}
    />
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
            ? []
            : comments?.at(props.file.path, side, number)
        }
      >
        {(comment) => card(comment)}
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
      {/* The bar carries no padding of its own: the expand button does, so the
          whole height of the row answers a click rather than the line of text
          in the middle of it. */}
      <div
        class={`sticky top-0 z-1 flex w-full items-center gap-2 pl-3 text-sm ${open() ? "bg-neutral-850" : "bg-neutral-925 hover:bg-neutral-900"}`}
      >
        <button
          type="button"
          role="checkbox"
          aria-checked={props.picked ? "true" : "false"}
          aria-label={`Pick ${props.file.path}`}
          title="Include in the commit"
          class="flex w-5 shrink-0 items-center justify-center self-stretch rounded text-neutral-500 hover:text-neutral-100"
          onClick={props.onTogglePicked}
        >
          <span
            class={
              props.picked
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
          class="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-3 text-left"
          onClick={toggle}
        >
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
            <For each={fileComments()}>{(comment) => card(comment)}</For>
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
