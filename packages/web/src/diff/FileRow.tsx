import { createMemo, createSignal, Show, useContext } from "solid-js";

import type { ToolDiffHunk } from "#core/shared/DiffLines";
import { DiffExpand, type DiffGap } from "#core/view/DiffExpand";
import type { ChangeSummary } from "#protocol/Diff";
import { Spinner } from "../ui/Spinner";
import { createAnchoring } from "./anchoring";
import { ReviewComments } from "./Comments";
import type { FileState } from "./DiffStore";
import { FileLabel } from "./FileLabel";
import { Stat } from "./Stat";
import { SplitDiff } from "./SplitHunk";
import { UnifiedDiff } from "./UnifiedDiff";

const LEAD = "text-neutral-400";

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
  readonly onExpand: () => void;
  /** Reads the file's own lines behind one gap and shows them. */
  readonly onOpen: (gap: DiffGap) => void;
  /** Old beside new rather than one column of both, as the pane's width allows. */
  readonly split: boolean;
}) {
  const [open, setOpen] = createSignal(false);
  const comments = useContext(ReviewComments)();

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

  const anchoring =
    comments === undefined
      ? undefined
      : createAnchoring({ comments, file: () => props.file, hunks });

  const truncated = createMemo(() => ready()?.truncated === true);

  const opening = createMemo(
    () => props.state?.kind === "ready" && props.state.opening
  );

  /**
   * What stands in for hunks a file has none of. Every comment is made by
   * pointing at something, so where there is no line to point at this is the
   * target instead.
   */
  const placeholder = createMemo(() => {
    const diff = ready();
    if (!props.file.binary && diff?.binary !== true) {
      return "no textual changes";
    }
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
        {/* The hunks run the full width of the pane, flush with the title bar
            over them: a diff is a column of its own numbering and its own
            code, and an inset would only narrow the code without lining it up
            with anything. The prose around them keeps the bar's inset, so a
            sentence still starts under the file's name. */}
        <div class="pb-2 text-sm">
          {/* A comment on the file itself has no gutter to hang beside, and
              its cross and `Stale` chip are placed where one would be — so the
              card is given that much room, or they would sit off the pane. */}
          <div class="px-3" style={{ "--gutter": "7ch" }}>
            {anchoring?.fileCards()}
          </div>
          <Show when={props.state?.kind === "loading"}>
            <span class={`flex items-center gap-2 px-3 ${LEAD}`}>
              <Spinner />
              reading the diff
            </span>
          </Show>
          <Show when={props.state?.kind === "error" ? props.state : undefined}>
            {(failed) => (
              <p class="px-3 whitespace-pre-wrap text-rose-400">
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
                    anchors={anchoring}
                  />
                }
              >
                <SplitDiff
                  path={props.file.path}
                  hunks={hunks()}
                  total={ready()?.total}
                  busy={opening()}
                  onOpen={props.onOpen}
                  anchors={anchoring}
                />
              </Show>
            </Show>
            <Show
              when={
                props.state?.kind === "ready" ? props.state.failed : undefined
              }
            >
              {(message) => (
                <p class="px-3 whitespace-pre-wrap text-rose-400">
                  {message()}
                </p>
              )}
            </Show>
            <Show when={truncated()}>
              <p class="px-3 text-amber-400">
                diff is very large — the rest is not shown
              </p>
            </Show>
            <Show when={hunks().length === 0 && !truncated()}>
              <Show
                when={anchoring !== undefined}
                fallback={<p class={`px-3 ${LEAD}`}>{placeholder()}</p>}
              >
                <button
                  type="button"
                  aria-label={`Comment on ${props.file.path}`}
                  class={`${LEAD} mx-2 rounded px-1 text-left hover:bg-indigo-500/10`}
                  onClick={() => {
                    anchoring?.pickFile();
                  }}
                >
                  {placeholder()}
                </button>
              </Show>
            </Show>
          </Show>
          {anchoring?.sheet()}
        </div>
      </Show>
    </div>
  );
}
