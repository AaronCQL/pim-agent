import { createMemo, Show } from "solid-js";

import type { ToolView, ViewBlock } from "#core/view/ViewBlock";
import { Spinner } from "../ui/Spinner";
import { Body } from "../view/Blocks";
import type { ToolRow } from "./rows";

/**
 * The one row in a transcript that opens a conversation instead of a payload.
 *
 * It is a button, not a disclosure: a subagent's run is a session of its own
 * and it is read in a modal, so there is no caret and no spine here. The spine
 * means "this hangs off the row above it", and nothing hangs off this.
 *
 * It is also the only fill in the transcript, which is allowed because it
 * holds no payload — three clamped lines of prose and a status line, with no
 * code block or diff wash inside it to be knocked off the `--line` grid by the
 * fill's own padding. That padding is a whole `--line` top and bottom and
 * carries no border, so the card is a whole number of rows tall and the tool
 * rows around it keep their grid, at either breakpoint.
 *
 * The face has to answer without being tapped, because the common case is
 * that it never is: running spins in amber, a settled run reads its roster
 * and its cost, and a failed one says so and why.
 */
export function SubagentCard(props: {
  readonly row: ToolRow;
  readonly onOpen: (callId: string) => void;
}) {
  const prompt = createMemo(() => titleText(props.row.view));
  const failure = createMemo(() =>
    props.row.isError ? failureText(props.row.view) : undefined
  );
  // A run that threw persists no details at all, so whatever accounting is
  // still on its view was painted from a snapshot mid-flight and was never
  // what the run cost. Reading it back off the row is the same mistake as
  // reading it back out of the error string: the numbers a failure has are in
  // its child log, which is a tap away.
  const summary = createMemo(() =>
    props.row.isError ? [] : (props.row.view.summary ?? [])
  );

  return (
    <button
      type="button"
      // The fill pair the queued message uses, and for the same reason: it is
      // the transcript's mark for a card a thumb is meant to land on.
      class="w-full min-w-0 rounded-lg bg-neutral-900 px-3 py-[--line] text-left hover:bg-neutral-850"
      onClick={() => {
        props.onOpen(props.row.id);
      }}
    >
      <Show
        when={props.row.isError}
        fallback={
          <div class="flex min-w-0 items-center gap-1ch">
            <span
              class={`font-bold ${props.row.isPartial ? "text-amber-400" : "text-neutral-50"}`}
            >
              Subagent
            </span>
            <Show when={props.row.isPartial}>
              <Spinner />
              <span class="text-amber-400">Running</span>
            </Show>
          </div>
        }
      >
        <p class="truncate text-rose-400">
          <span class="font-bold">Subagent failed</span>
          <Show when={failure()}>{(reason) => ` · ${reason()}`}</Show>
        </p>
      </Show>
      <Show when={prompt() !== ""}>
        <p class="line-clamp-3 whitespace-pre-wrap break-words">{prompt()}</p>
      </Show>
      <Show when={summary().length > 0}>
        <div class="text-neutral-400">
          <Body blocks={summary()} />
        </div>
      </Show>
    </button>
  );
}

/**
 * The prompt as text rather than as blocks: it is clamped to three lines, and
 * markdown inside a clamp is a heading or a list marker sized off the grid.
 * What is wanted here is what was asked for, not a rendering of it.
 */
function titleText(view: ToolView): string {
  return view.title
    .map(blockText)
    .filter((text) => text !== "")
    .join(" ")
    .trim();
}

/**
 * Why the run did not happen. A failed call's view is painted from its
 * arguments and carries pi's error text as its body, so the reason is there
 * whatever the tool's own renderer would have drawn — and the first line of it
 * is what fits on a face; the rest is in the modal.
 */
function failureText(view: ToolView): string | undefined {
  for (const block of view.body ?? []) {
    const line = blockText(block).trim().split(/\r?\n/u)[0]?.trim();
    if (line !== undefined && line !== "") {
      return line;
    }
  }
  return undefined;
}

function blockText(block: ViewBlock): string {
  switch (block.kind) {
    case "text":
    case "markdown":
    case "notice":
      return block.text;
    case "spans":
      return block.spans.map((span) => span.text).join("");
    case "file":
      return block.path;
    default:
      return "";
  }
}
