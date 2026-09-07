import { Dynamic } from "@solidjs/web";
import { createMemo, For, Show, type Component } from "solid-js";

import type { DurableEvent } from "#protocol/ServerEvent";
import { clockTime } from "../format";
import { Markdown } from "../markdown/Markdown";
import type { LiveMessage, PendingMessage } from "../session/SessionStore";
import { ToolCard } from "../view/ToolCard";
import { NOTICE_CLASSES } from "../view/tokens";
import {
  buildRows,
  extendRows,
  type MessageRow,
  type NoticeRow,
  type Row,
  type ToolRow,
} from "./rows";

type RowOf<TKind extends Row["kind"]> = Extract<Row, { kind: TKind }>;

type RowMap = {
  readonly [TKind in Row["kind"]]: Component<{
    readonly row: RowOf<TKind>;
  }>;
};

/**
 * The whole conversation, painted from durable events alone.
 *
 * `trailing` is what this client has said and not yet had echoed back; `live`
 * is the turn in flight, a message per step with the calls that step made.
 * Both merge into the durable rows through `extendRows`, which dedupes calls
 * on `callId`, so a call keeps one row from the moment it starts to the
 * moment its result lands.
 *
 * Two memos so a text delta, which ticks many times a second, only rebuilds
 * the few trailing rows: the durable log is flattened once per durable event,
 * not once per delta. Keyed on the row id rather than on identity, because
 * the trailing rows are still rebuilt on every delta and an unkeyed `<For>`
 * would remount them each time.
 */
export function Transcript(props: {
  readonly events: readonly DurableEvent[];
  readonly trailing?: readonly PendingMessage[];
  readonly live?: readonly LiveMessage[];
  /**
   * Take the queued message back to edit it. There is only ever one, so this
   * needs no argument — pi holds a single message per turn, and every row
   * that offers this is drawing that one.
   */
  readonly onEdit?: () => void;
}) {
  const durable = createMemo(() => buildRows(props.events));
  const rows = createMemo(() =>
    extendRows(durable(), props.trailing ?? [], props.live ?? [])
  );
  const groups = createMemo(() => groupRuns(rows()));
  // Built here rather than at module scope so the message row can be handed
  // the one thing a row is allowed to do. The body runs once per mount, so
  // the component identities are stable and `<Dynamic>` never remounts a row.
  const painters: RowMap = {
    message: (message) => (
      <MessageBubble row={message.row} onEdit={props.onEdit} />
    ),
    tool: ToolRowView,
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

/**
 * A run of consecutive tool rows is one group and gets no gaps inside it, the
 * way the mockup stacks four calls as four adjacent lines. Everything else is
 * its own group, so the only vertical space in a transcript is a whole blank
 * row between things that are not a list of calls.
 */
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

/** The column a user turn lives in, whether or not it has been heard. */
const COLUMN = "flex max-w-[85%] min-w-0 flex-col items-end";

/**
 * A user turn is the mockup's right-aligned card; an assistant turn is not a
 * bubble at all — it is prose on the line grid, and copying it is the job of
 * the buttons on the payloads inside it.
 *
 * A queued message is drawn as the same card, faded, and the card is a
 * button: it is a thing this reader has said that the agent has not heard
 * yet, so it is still theirs to take back. The whole card is the target
 * rather than a control tucked into a corner of it, because on a phone the
 * corner is smaller than the thumb aiming at it.
 */
function MessageBubble(props: {
  readonly row: MessageRow;
  readonly onEdit?: () => void;
}) {
  return (
    <Show
      when={props.row.role === "user"}
      fallback={
        <article class="min-w-0 space-y-[--line]">
          <Show when={props.row.thinking}>
            {(thinking) => (
              // Thinking is markdown too, so it gets the same painter as the
              // answer; only weight and opacity say it is not the answer. Once
              // the answer has started the thinking can no longer grow, so it
              // is flushed even while the message is still streaming.
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
            class={`${COLUMN} cursor-pointer text-left opacity-60 hover:opacity-100`}
            onClick={() => props.onEdit?.()}
          >
            <Card row={props.row} />
          </button>
        </Show>
      </article>
    </Show>
  );
}

/**
 * The card and what it says beneath itself: the wall clock once the message
 * has been written down, and — while pi is still holding it — that it has
 * not been, which is worth saying out loud where the time would go.
 */
function Card(props: { readonly row: MessageRow }) {
  return (
    <>
      <div class="min-w-0 whitespace-pre-wrap break-words rounded-lg bg-neutral-850 px-4 py-3">
        {props.row.text}
      </div>
      <div class="text-sm text-neutral-500">
        {props.row.queued
          ? "Queued. Click to edit."
          : clockTime(props.row.timestamp)}
      </div>
    </>
  );
}

function ToolRowView(props: { readonly row: ToolRow }) {
  return (
    <ToolCard
      view={props.row.view}
      name={props.row.name}
      isError={props.row.isError}
      isPartial={props.row.isPartial}
    />
  );
}

function NoticeRowView(props: { readonly row: NoticeRow }) {
  return (
    <p class={`text-center text-sm ${NOTICE_CLASSES[props.row.severity]}`}>
      {props.row.text}
    </p>
  );
}
