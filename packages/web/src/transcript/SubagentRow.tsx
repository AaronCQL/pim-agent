import { createMemo, Show } from "solid-js";

import type { ToolView, ViewBlock } from "#core/view/ViewBlock";
import { Caret } from "../ui/Collapsible";
import { Spinner } from "../ui/Spinner";
import { RowLabel } from "../view/ToolCard";
import { caretClass } from "../view/tokens";
import type { ToolRow } from "./rows";

/** The tool row that opens a conversation instead of a payload: a button, not a disclosure. */
export function SubagentRow(props: {
  readonly row: ToolRow;
  readonly onOpen: (callId: string) => void;
}) {
  // A run that threw kept no details, so its accounting is a mid-flight snapshot.
  const stats = createMemo(() =>
    props.row.isError ? "" : summaryText(props.row.view)
  );
  const failure = createMemo(() =>
    props.row.isError ? failureText(props.row.view) : undefined
  );

  return (
    <button
      type="button"
      aria-haspopup="dialog"
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
            <Show when={props.row.isPartial}>
              <span class="ml-1ch inline-flex align-middle">
                <Spinner />
              </span>
            </Show>
          </>
        }
      >
        <span class="block truncate text-rose-400">
          failed
          {/* Read in JSX: the `Show` callback runs untracked, so a reason
              interpolated into a string would never reach the page. */}
          <Show when={failure()}>{(reason) => <> · {reason()}</>}</Show>
        </span>
      </Show>
    </button>
  );
}

function summaryText(view: ToolView): string {
  return (view.summary ?? []).map(blockText).join("").trim();
}

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
