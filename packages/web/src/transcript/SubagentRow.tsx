import { createMemo, Show } from "solid-js";

import type { ToolView, ViewBlock } from "#core/view/ViewBlock";
import { Caret } from "../ui/Collapsible";
import { Spinner } from "../ui/Spinner";
import { RowLabel } from "../view/ToolCard";
import { caretClass } from "../view/tokens";
import type { ToolRow } from "./rows";

/**
 * The one row in a transcript that opens a conversation instead of a payload.
 *
 * It keeps the tool row's grammar — caret, bold label, muted colon, text at
 * the `2ch` column — because it *is* a tool call, and a run of calls that a
 * subagent sits in the middle of has one left edge. What it is not is a
 * disclosure: a subagent's run is a session of its own, read in a modal, so
 * this is a `<button>`, and the caret never rotates and draws no spine. That
 * is the whole of the distinction, and it is the one readers already know:
 * a chevron that turns means "this opens below me", a chevron that stays put
 * means "this takes you somewhere". Nothing hangs here, so nothing turns.
 *
 * What sits after the colon is what the run cost, and only that. The prompt
 * is not on the row at all: it is the child's first message, so anyone who
 * opens the run reads it in full as the first thing in the modal, and putting
 * it here spends a second line — in a list whose every other entry is one —
 * repeating what the tap already gives. The accounting is the opposite; it
 * exists nowhere else on this screen, and it is what a reader who never taps
 * is owed. So it takes the title's place rather than trailing it as a muted
 * aside, and it reads at the row's own colour, exactly like the path after
 * `Read:` or the pipeline after `Bash:`.
 *
 * State is left to the marks that already carry it everywhere else: the caret
 * and the label go amber while the run works and rose if it threw, and a
 * failure replaces the accounting with its reason.
 */
export function SubagentRow(props: {
  readonly row: ToolRow;
  readonly onOpen: (callId: string) => void;
}) {
  // A run that threw persists no details at all, so whatever accounting is
  // still on its view was painted from a snapshot mid-flight and was never
  // what the run cost. Reading it back off the row is the same mistake as
  // reading it back out of the error string: the numbers a failure has are in
  // its child log, which is a tap away.
  const stats = createMemo(() =>
    props.row.isError ? "" : summaryText(props.row.view)
  );
  const failure = createMemo(() =>
    props.row.isError ? failureText(props.row.view) : undefined
  );

  return (
    <button
      type="button"
      // Says out loud what the still caret says by staying still, for the
      // reader who never sees the glyph. There is deliberately no
      // `aria-label` beside it: a label would name this button "open
      // subagent run" and throw away the accounting, which is the whole of
      // what the row says. The row's own text is its name, and this is the
      // one word missing from it.
      aria-haspopup="dialog"
      // `pl-2ch` and `relative` are the tool row's grid: the caret hangs in
      // the gutter and the text keeps one left edge however far it wraps, and
      // `flow-root` holds the floated label inside the row on the run that
      // has yet to spend anything. The recession every tool row has comes
      // with it, and it lifts on hover for the same reason theirs do: there
      // is something behind this one to reach.
      class="relative w-full min-w-0 flow-root pl-2ch text-left opacity-80 focus-visible:opacity-100 hover:opacity-100"
      onClick={() => {
        props.onOpen(props.row.id);
      }}
    >
      <Caret class={caretClass(props.row.isPartial, props.row.isError)} />
      <RowLabel label="Subagent" tone={props.row.view.labelTone} />
      <Show
        when={props.row.isError}
        fallback={
          <>
            <Show when={stats() !== ""}>
              <span class="break-words">{stats()}</span>
            </Show>
            {/* The spinner is a sized box in what is now a run of text, and a
                bare inline box would drop its own width and height; the
                wrapper blockifies it and sits it on the text's middle. On the
                narrowest phone it wraps to the next line intact rather than
                squeezing the accounting. */}
            <Show when={props.row.isPartial}>
              <span class="ml-1ch inline-flex align-middle">
                <Spinner />
              </span>
            </Show>
          </>
        }
      >
        {/* `block` so the reason can be clipped to the one line that fits:
            it establishes a formatting context of its own and so is laid out
            beside the floated label rather than flowing around it. */}
        <span class="block truncate text-rose-400">
          failed
          {/* The reason is read in JSX rather than interpolated into a
              string: the children callback runs once and untracked, so a
              reason that arrives later would never reach the page. */}
          <Show when={failure()}>{(reason) => <> · {reason()}</>}</Show>
        </span>
      </Show>
    </button>
  );
}

/**
 * What the run spent, flattened out of the one `spans` block the tool renders
 * it as. The spans' own tones are dropped rather than painted: they mute the
 * accounting into an aside and tint it amber mid-flight, and here it is
 * neither — it is the row's subject, and the caret beside it is already
 * saying whether the run is still going.
 */
function summaryText(view: ToolView): string {
  return (view.summary ?? []).map(blockText).join("").trim();
}

/**
 * Why the run did not happen. A failed call's view is painted from its
 * arguments and carries pi's error text as its body, so the reason is there
 * whatever the tool's own renderer would have drawn — and the first line of it
 * is what fits on a row; the rest is in the modal.
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
