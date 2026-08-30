import type { ToolView } from "../../../core/src/view/ViewBlock";
import type { DurableEvent } from "../../../protocol/src/ServerEvent";

export type MessageRow = {
  readonly kind: "message";
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly thinking?: string;
};

export type ToolRow = {
  readonly kind: "tool";
  readonly id: string;
  readonly name: string;
  readonly view: ToolView;
  readonly isError: boolean;
  /** The call is on the wire but its result has not landed yet. */
  readonly isPartial: boolean;
};

export type NoticeRow = {
  readonly kind: "notice";
  readonly id: string;
  readonly severity: "info" | "warn" | "error";
  readonly text: string;
};

export type Row = MessageRow | ToolRow | NoticeRow;

/**
 * Flattens durable events into the rows a transcript draws. A tool appears
 * twice on the wire — once as the requesting message's `toolCalls`, once as
 * its own `tool_result` — and the protocol says to dedupe on `callId`, so the
 * result upgrades the row in place rather than appending a second one. That
 * keeps a call that never finished visible as a partial row.
 */
export function toRows(events: readonly DurableEvent[]): readonly Row[] {
  const rows: Row[] = [];
  const toolIndex = new Map<string, number>();

  for (const event of events) {
    switch (event.type) {
      case "message": {
        if (event.text !== "" || event.thinking !== undefined) {
          rows.push({
            kind: "message",
            id: event.messageId,
            role: event.role,
            text: event.text,
            ...(event.thinking === undefined
              ? {}
              : { thinking: event.thinking }),
          });
        }
        for (const call of event.toolCalls ?? []) {
          toolIndex.set(call.callId, rows.length);
          rows.push({
            kind: "tool",
            id: call.callId,
            name: call.name,
            view: call.view,
            isError: false,
            isPartial: true,
          });
        }
        break;
      }
      case "tool_result": {
        const row: ToolRow = {
          kind: "tool",
          id: event.callId,
          name: event.name,
          view: event.view,
          isError: event.isError,
          isPartial: false,
        };
        const at = toolIndex.get(event.callId);
        if (at === undefined) {
          toolIndex.set(event.callId, rows.length);
          rows.push(row);
        } else {
          rows[at] = row;
        }
        break;
      }
      case "notice":
        rows.push({
          kind: "notice",
          id: `notice-${event.seq}`,
          severity: event.severity,
          text: event.text,
        });
        break;
    }
  }

  return rows;
}
