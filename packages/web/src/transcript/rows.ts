import type { ToolView } from "../../../core/src/view/ViewBlock";
import type { DurableEvent } from "../../../protocol/src/ServerEvent";

export type MessageRow = {
  readonly kind: "message";
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly thinking?: string;
  /**
   * The turn still in flight. The markdown renderer must not be flushed while
   * this is set, or every delta would repaint the whole message.
   */
  readonly streaming?: boolean;
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

/** The rows plus the dedupe index, so a later batch can keep merging into them. */
export type RowBuild = {
  readonly rows: readonly Row[];
  readonly toolIndex: ReadonlyMap<string, number>;
};

/**
 * Folds one durable event into the rows a transcript draws. A tool appears at
 * least twice on the wire — as the requesting message's `toolCalls`, as its
 * own `tool_result`, and again in the in-flight bucket while it runs — and the
 * protocol says to dedupe on `callId`, so each later sighting upgrades the row
 * in place rather than appending a second one. That is also what lets the live
 * turn be appended as an ordinary assistant `message` with no special case:
 * its tool rows merge with the durable ones for free. A call whose result
 * never landed stays a partial row.
 */
function append(
  rows: Row[],
  toolIndex: Map<string, number>,
  event: DurableEvent,
  streamingId?: string
): void {
  switch (event.type) {
    case "message": {
      if (event.text !== "" || event.thinking !== undefined) {
        rows.push({
          kind: "message",
          id: event.messageId,
          role: event.role,
          text: event.text,
          ...(event.thinking === undefined ? {} : { thinking: event.thinking }),
          ...(event.messageId === streamingId ? { streaming: true } : {}),
        });
      }
      for (const call of event.toolCalls ?? []) {
        const row: ToolRow = {
          kind: "tool",
          id: call.callId,
          name: call.name,
          view: call.view,
          isError: false,
          isPartial: true,
        };
        const at = toolIndex.get(call.callId);
        if (at === undefined) {
          toolIndex.set(call.callId, rows.length);
          rows.push(row);
        } else if ((rows[at] as ToolRow).isPartial) {
          // The live turn re-states the calls its durable message already
          // listed; the later view is the fresher one, and a landed result
          // outranks both.
          rows[at] = row;
        }
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

export function buildRows(
  events: readonly DurableEvent[],
  streamingId?: string
): RowBuild {
  const rows: Row[] = [];
  const toolIndex = new Map<string, number>();
  for (const event of events) {
    append(rows, toolIndex, event, streamingId);
  }
  return { rows, toolIndex };
}

/**
 * Continues a build with the trailing in-flight events, copying it first so
 * the base — a memo of the whole durable log — is never mutated. The copy is
 * shallow, which is the point: on a text delta the durable row objects keep
 * their identity, and only the handful of trailing rows are rebuilt.
 */
export function extendRows(
  base: RowBuild,
  events: readonly DurableEvent[],
  streamingId?: string
): readonly Row[] {
  if (events.length === 0) {
    return base.rows;
  }
  const rows = [...base.rows];
  const toolIndex = new Map(base.toolIndex);
  for (const event of events) {
    append(rows, toolIndex, event, streamingId);
  }
  return rows;
}

export function toRows(
  events: readonly DurableEvent[],
  streamingId?: string
): readonly Row[] {
  return buildRows(events, streamingId).rows;
}
