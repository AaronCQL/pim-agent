import { createMemo, Show } from "solid-js";

import type { ToolView, ViewBlock } from "#core/view/ViewBlock";
import { Caret } from "../ui/Collapsible";
import { Spinner } from "../ui/Spinner";
import { RowLabel } from "../view/ToolCard";
import { caretClass } from "../view/tokens";
import type { ToolRow } from "./rows";

export function SubagentRow(props: {
  readonly row: ToolRow;
  readonly onOpen: () => void;
}) {
  // A failed run's usage is a stale mid-run snapshot.
  const stats = createMemo(() =>
    props.row.isError ? "" : titleText(props.row.view)
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
        props.onOpen();
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
          <Show when={props.row.handle}>
            {(handle) => <span class="text-neutral-400">{handle()} ⬝ </span>}
          </Show>
          {props.row.state ?? "failed"}
          <Show when={failure()}>{(reason) => <> · {reason()}</>}</Show>
        </span>
      </Show>
    </button>
  );
}

function titleText(view: ToolView): string {
  return view.title.map(blockText).join("").trim();
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
