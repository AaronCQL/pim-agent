import { Dynamic } from "@solidjs/web";
import { createMemo, Show, useContext } from "solid-js";

import type { ToolDiffHunk } from "#core/shared/DiffLines";
import { DiffExpand, type DiffGap } from "#core/view/DiffExpand";
import type { ChangeSummary } from "#protocol/Diff";
import { Spinner } from "../ui/Spinner";
import { createAnchoring } from "./anchoring";
import { comments, ReviewComments } from "./Comments";
import type { FileState } from "./DiffStore";
import { FileLabel } from "./FileLabel";
import { Stat } from "./Stat";
import { SplitDiff } from "./SplitDiff";
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

export function FileRow(props: {
  readonly file: ChangeSummary;
  readonly state: FileState | undefined;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onOpen: (gap: DiffGap) => void;
  readonly split: boolean;
}) {
  const notes = useContext(ReviewComments)();

  const ready = createMemo(() =>
    props.state?.kind === "ready" ? props.state : undefined
  );

  const hunks = createMemo<readonly ToolDiffHunk[]>(() => {
    const state = ready();
    return state !== undefined &&
      !props.file.binary &&
      state.diff.hunks.length > 0
      ? DiffExpand.expand(state.diff.hunks, state.lines)
      : [];
  });

  const anchoring =
    notes === undefined
      ? undefined
      : createAnchoring({ comments: notes, file: () => props.file, hunks });

  const truncated = createMemo(() => ready()?.diff.truncated === true);

  /** Shown when there are no hunks; doubles as the file-comment target. */
  const placeholder = createMemo(() => {
    const diff = ready()?.diff;
    if (!props.file.binary && diff?.binary !== true) {
      return "no textual changes";
    }
    const sizes = [diff?.oldBytes, diff?.newBytes]
      .filter((side) => side !== undefined)
      .map(bytes)
      .join(" → ");
    return sizes === "" ? "binary file" : `binary file ${sizes}`;
  });

  const badge = createMemo(() => notes?.count(props.file.path) ?? 0);

  return (
    <div class="border-b border-neutral-850 last:border-b-0">
      <div
        class={`sticky top-0 z-1 flex w-full items-center gap-2 px-3 text-sm ${props.open ? "bg-neutral-850" : "bg-neutral-925 hover:bg-neutral-900"}`}
      >
        <button
          type="button"
          aria-expanded={props.open ? "true" : "false"}
          aria-label={props.file.path}
          class="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
          onClick={props.onToggle}
        >
          <span
            class={`i-griddy-icons:chevron-right-small-filled size-4 shrink-0 text-neutral-400 transition-transform ${props.open ? "rotate-90" : ""}`}
            aria-hidden="true"
          />
          <FileLabel file={props.file} />
          <Show when={badge() > 0}>
            <span
              class="i-griddy-icons:chat-bubble-dots size-4 shrink-0 text-indigo-300"
              role="img"
              aria-label={comments(badge())}
              title={comments(badge())}
            />
          </Show>
          <Show
            when={!props.file.binary}
            fallback={<span class={`shrink-0 ${LEAD}`}>binary</span>}
          >
            <Stat added={props.file.added} removed={props.file.removed} />
          </Show>
        </button>
      </div>

      <Show when={props.open}>
        <div class="pb-2 text-sm">
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
          <Show when={ready()}>
            <Show when={hunks().length > 0}>
              <Dynamic
                component={props.split ? SplitDiff : UnifiedDiff}
                path={props.file.path}
                hunks={hunks()}
                total={ready()?.diff.total}
                busy={ready()?.opening === true}
                onOpen={props.onOpen}
                anchors={anchoring}
              />
            </Show>
            <Show when={ready()?.failed}>
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
