import { Dynamic } from "@solidjs/web";
import { createMemo, For, Show, useContext, type Component } from "solid-js";

import type { DurableEvent } from "#protocol/ServerEvent";
import { clockTime } from "../format";
import { Markdown } from "../markdown/Markdown";
import type { LiveMessage, PendingMessage } from "../session/SessionStore";
import { HideThinking } from "../settings/Settings";
import { Attachments } from "../view/Attachments";
import { Notice } from "../view/Blocks";
import { ToolCards } from "../view/ToolCard";
import { SubagentRow } from "./SubagentRow";
import {
  buildRows,
  extendRows,
  type MessageRow,
  type NoticeRow,
  type Row,
  type ToolRow,
} from "./rows";

const SUBAGENT = "subagent";

type RowOf<TKind extends Row["kind"]> = Extract<Row, { kind: TKind }>;

type RowMap = {
  readonly [TKind in Row["kind"]]: Component<{
    readonly row: RowOf<TKind>;
  }>;
};

/**
 * The whole conversation: durable rows extended with this client's unechoed
 * messages and the turn in flight. Keyed by row id, since the trailing rows
 * are rebuilt on every delta and an unkeyed `<For>` would remount them.
 */
export function Transcript(props: {
  readonly events: readonly DurableEvent[];
  readonly trailing?: readonly PendingMessage[];
  readonly live?: readonly LiveMessage[];
  readonly onEdit?: () => void;
  readonly onOpenSubagent?: (callId: string) => void;
}) {
  const durable = createMemo(() => buildRows(props.events));
  const rows = createMemo(() =>
    extendRows(durable(), props.trailing ?? [], props.live ?? [])
  );
  const hidden = useContext(HideThinking);
  const groups = createMemo(() =>
    groupRuns(rows().filter((row) => draws(row, hidden())))
  );
  // Built once per mount: stable identities keep `<Dynamic>` from remounting rows.
  const painters: RowMap = {
    message: (message) => (
      <MessageBubble
        row={message.row}
        hidden={hidden()}
        onEdit={props.onEdit}
      />
    ),
    tool: (tool) => (
      <ToolRowView row={tool.row} onOpenSubagent={props.onOpenSubagent} />
    ),
    notice: NoticeRowView,
  };

  return (
    <div class="space-y-[--line]">
      <For each={groups()} keyed={(group: Group) => group.id}>
        {(group) => (
          <div class="min-w-0">
            <For each={group().rows} keyed={(row: Row) => row.id}>
              {(row) => (
                <Dynamic
                  component={painters[row().kind] as Component<{ row: Row }>}
                  row={row()}
                />
              )}
            </For>
          </div>
        )}
      </For>
    </div>
  );
}

type Group = { readonly id: string; readonly rows: readonly Row[] };

// Filtered rather than skipped while painting: a hidden row still ends a run of calls.
function draws(row: Row, hidden: boolean): boolean {
  return !(
    hidden &&
    row.kind === "message" &&
    row.thinking !== undefined &&
    row.text === "" &&
    row.attachments === undefined
  );
}

function groupRuns(rows: readonly Row[]): readonly Group[] {
  const groups: Group[] = [];
  let run: Row[] | undefined;
  for (const row of rows) {
    if (row.kind === "tool" && run) {
      run.push(row);
      continue;
    }
    run = row.kind === "tool" ? [row] : undefined;
    groups.push({ id: row.id, rows: run ?? [row] });
  }
  return groups;
}

const COLUMN = "flex max-w-[85%] min-w-0 flex-col items-end";

function MessageBubble(props: {
  readonly row: MessageRow;
  readonly hidden: boolean;
  readonly onEdit?: () => void;
}) {
  return (
    <Show
      when={props.row.role === "user"}
      fallback={
        <article class="min-w-0 space-y-[--line]">
          <Show when={!props.hidden && props.row.thinking}>
            {(thinking) => (
              // Thinking cannot grow once the answer starts, so it is flushed then.
              <div class="font-300 italic opacity-60">
                <Markdown
                  text={thinking()}
                  complete={
                    props.row.streaming !== true || props.row.text !== ""
                  }
                />
              </div>
            )}
          </Show>
          <Markdown
            text={props.row.text}
            complete={props.row.streaming !== true}
          />
        </article>
      }
    >
      <article class="flex flex-col items-end">
        <Show when={props.row.attachments}>
          {(files) => (
            <div class="mb-1.5">
              <Attachments
                files={files().map((file) => ({ ...file, key: file.url }))}
              />
            </div>
          )}
        </Show>
        <Show
          when={props.row.queued}
          fallback={
            <div class={COLUMN}>
              <Card row={props.row} />
            </div>
          }
        >
          <button
            type="button"
            aria-label="Edit queued message"
            class={`group ${COLUMN} text-left`}
            onClick={() => props.onEdit?.()}
          >
            <Card row={props.row} />
          </button>
        </Show>
      </article>
    </Show>
  );
}

function Card(props: { readonly row: MessageRow }) {
  return (
    <>
      <Show when={props.row.text !== ""}>
        <div
          // `wrap-anywhere`, not `break-words`: the card's own intrinsic width
          // has to count the break, or a long path lays it out past the column.
          class={`whitespace-pre-wrap wrap-anywhere rounded-lg px-4 py-3 ${
            props.row.queued
              ? "bg-neutral-900 text-neutral-400 group-hover:bg-neutral-850 group-hover:text-neutral-200"
              : "bg-neutral-850"
          }`}
        >
          {props.row.text}
        </div>
      </Show>
      <div
        class={`text-sm ${props.row.queued ? "text-neutral-400" : "text-neutral-500"}`}
      >
        {props.row.queued
          ? "Queued. Click to edit."
          : clockTime(props.row.timestamp)}
      </div>
    </>
  );
}

function ToolRowView(props: {
  readonly row: ToolRow;
  readonly onOpenSubagent?: (callId: string) => void;
}) {
  return (
    <Show
      when={props.row.name === SUBAGENT && props.onOpenSubagent !== undefined}
      fallback={
        <ToolCards
          view={props.row.view}
          name={props.row.name}
          isError={props.row.isError}
          isPartial={props.row.isPartial}
        />
      }
    >
      <SubagentRow
        row={props.row}
        onOpen={(callId) => props.onOpenSubagent?.(callId)}
      />
    </Show>
  );
}

const NOTICE_LABELS = {
  info: "INFO",
  warn: "WARNING",
  error: "ERROR",
} as const satisfies Record<NoticeRow["severity"], string>;

function NoticeRowView(props: { readonly row: NoticeRow }) {
  return (
    <Notice
      severity={props.row.severity}
      text={props.row.text}
      tag={
        <span class="mr-1ch rounded bg-current/10 px-1.5 py-0.5 text-sm font-semibold">
          {NOTICE_LABELS[props.row.severity]}
        </span>
      }
    />
  );
}
