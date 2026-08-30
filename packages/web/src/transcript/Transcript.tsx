import { Dynamic } from "@solidjs/web";
import { For, Show, type Component } from "solid-js";

import type { DurableEvent } from "../../../protocol/src/ServerEvent";
import { Markdown } from "../markdown/Markdown";
import { Collapsible } from "../ui/Collapsible";
import { CopyButton } from "../ui/CopyButton";
import { ToolCard } from "../view/ToolCard";
import { NOTICE_CLASSES } from "../view/tokens";
import {
  toRows,
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
 * turn reaches here as an ordinary assistant `message`, which is what lets the
 * in-flight bucket merge with the durable log through `toRows` and nothing
 * else.
 *
 * Keyed on the row id rather than on identity, because `toRows` rebuilds every
 * row object on every delta and an unkeyed `<For>` would remount the entire
 * transcript sixty times a second.
 */
export function Transcript(props: {
  readonly events: readonly DurableEvent[];
  readonly streamingId?: string;
}) {
  return (
    <div class="flex flex-col gap-3">
      <For
        each={toRows(props.events, props.streamingId)}
        keyed={(row: Row) => row.id}
      >
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
