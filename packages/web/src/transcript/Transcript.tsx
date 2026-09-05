import { Dynamic } from "@solidjs/web";
import { createMemo, For, Show, type Component } from "solid-js";

import type { DurableEvent } from "#protocol/ServerEvent";
import { Markdown } from "../markdown/Markdown";
import { Collapsible } from "../ui/Collapsible";
import { CopyButton } from "../ui/CopyButton";
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
  return (
    <div class="flex flex-col gap-3">
      <For each={rows()} keyed={(row: Row) => row.id}>
        {(row) => (
          <Dynamic
            component={ROWS[row().kind] as Component<{ row: Row }>}
            row={row()}
          />
        )}
      </For>
    </div>
  );
}

function MessageBubble(props: { readonly row: MessageRow }) {
  return (
    <article
      class={{
        "group/message relative min-w-0 rounded-lg px-3 py-2": true,
        "self-end max-w-[80%] bg-sky-950/50 text-neutral-100":
          props.row.role === "user",
        "bg-neutral-900/40 text-neutral-200": props.row.role === "assistant",
      }}
    >
      <Show when={props.row.thinking}>
        {(thinking) => (
          <Collapsible summary={<span class="text-neutral-500">Thinking</span>}>
            <p class="whitespace-pre-wrap text-neutral-500">{thinking()}</p>
          </Collapsible>
        )}
      </Show>
      <Markdown text={props.row.text} complete={props.row.streaming !== true} />
      <CopyButton
        text={() => props.row.text}
        label="Copy message"
        class="absolute right-1 top-1 opacity-0 group-hover/message:opacity-100"
      />
    </article>
  );
}

function ToolRowView(props: { readonly row: ToolRow }) {
  return (
    <ToolCard
      view={props.row.view}
      isError={props.row.isError}
      isPartial={props.row.isPartial}
    />
  );
}

function NoticeRowView(props: { readonly row: NoticeRow }) {
  return (
    <p class={`text-center text-xs ${NOTICE_CLASSES[props.row.severity]}`}>
      {props.row.text}
    </p>
  );
}

const ROWS: RowMap = {
  message: MessageBubble,
  tool: ToolRowView,
  notice: NoticeRowView,
};
