import { Dynamic } from "@solidjs/web";
import { createMemo, For, Show, type Component } from "solid-js";

import type { DurableEvent } from "#protocol/ServerEvent";
import { Markdown } from "../markdown/Markdown";
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
 * `streamingId` names the one message whose markdown must stay open; the live
 * turn reaches here as `trailing` — ordinary assistant `message`s — which is
 * what lets the in-flight bucket merge with the durable log through
 * `extendRows` and nothing else.
 *
 * Two memos so a text delta, which ticks many times a second, only rebuilds
 * the few trailing rows: the durable log is flattened once per durable event,
 * not once per delta. Keyed on the row id rather than on identity, because
 * the trailing rows are still rebuilt on every delta and an unkeyed `<For>`
 * would remount them each time.
 */
export function Transcript(props: {
  readonly events: readonly DurableEvent[];
  readonly trailing?: readonly DurableEvent[];
  readonly streamingId?: string;
}) {
  const durable = createMemo(() => buildRows(props.events, props.streamingId));
  const rows = createMemo(() =>
    extendRows(durable(), props.trailing ?? [], props.streamingId)
  );
  const groups = createMemo(() => groupRuns(rows()));

  return (
    <div class="space-y-[--line]">
      <For each={groups()} keyed={(group: Group) => group.id}>
        {(group) => (
          <div class="min-w-0">
            <For each={group().rows} keyed={(row: Row) => row.id}>
              {(row) => (
                <Dynamic
                  component={ROWS[row().kind] as Component<{ row: Row }>}
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

/**
 * A user turn is the mockup's right-aligned card; an assistant turn is not a
 * bubble at all — it is prose on the line grid, and copying it is the job of
 * the buttons on the payloads inside it.
 *
 * (Phase B adds the `17:24` line under the user card, once messages carry a
 * timestamp.)
 */
function MessageBubble(props: { readonly row: MessageRow }) {
  return (
    <Show
      when={props.row.role === "user"}
      fallback={
        <article class="min-w-0 space-y-[--line]">
          <Show when={props.row.thinking}>
            {(thinking) => (
              <p class="whitespace-pre-wrap italic opacity-60">
                <span class="font-bold">Thinking: </span>
                {thinking()}
              </p>
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
        <div class="max-w-[85%] min-w-0 whitespace-pre-wrap break-words rounded-lg bg-neutral-850 px-4 py-3">
          {props.row.text}
        </div>
      </article>
    </Show>
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

const ROWS: RowMap = {
  message: MessageBubble,
  tool: ToolRowView,
  notice: NoticeRowView,
};
