import type { ToolView } from "#core/view/ViewBlock";
import type { DurableEvent } from "#protocol/ServerEvent";
import type { LiveMessage } from "../session/SessionStore";

export type MessageRow = {
  readonly kind: "message";
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  /** When pi wrote the message, in epoch ms. */
  readonly timestamp: number;
  readonly thinking?: string;
  /**
   * Still streaming, which is true of live rows and of nothing else. The
   * markdown renderer must not be flushed while it is set, or every delta
   * would repaint the whole message.
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
 * in place rather than appending a second one. A call whose result never
 * landed stays a partial row.
 */
function append(
  rows: Row[],
  toolIndex: Map<string, number>,
  event: DurableEvent
): void {
  switch (event.type) {
    case "message": {
      // Trimmed because the block is drawn `whitespace-pre-wrap`: models end
      // reasoning with a newline or two, and untrimmed those are blank lines
      // between the thinking and the prose it introduces.
      const thinking = event.thinking?.trim() ?? "";
      if (event.text !== "" || thinking !== "") {
        rows.push({
          kind: "message",
          id: event.messageId,
          role: event.role,
          text: event.text,
          timestamp: event.timestamp,
          ...(thinking === "" ? {} : { thinking }),
        });
      }
      for (const call of event.toolCalls ?? []) {
        upsertTool(rows, toolIndex, {
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
      upsertTool(rows, toolIndex, {
        kind: "tool",
        id: event.callId,
        name: event.name,
        view: event.view,
        isError: event.isError,
        isPartial: false,
      });
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

/**
 * A later sighting of a call upgrades its row in place; a settled one is
 * never downgraded back to partial by a re-stated call.
 */
function upsertTool(
  rows: Row[],
  toolIndex: Map<string, number>,
  row: ToolRow
): void {
  const at = toolIndex.get(row.id);
  if (at === undefined) {
    toolIndex.set(row.id, rows.length);
    rows.push(row);
    return;
  }
  if ((rows[at] as ToolRow).isPartial || !row.isPartial) {
    rows[at] = row;
  }
}

/**
 * Folds the in-flight turn in after the durable rows: one row per live
 * assistant message, each followed by the calls it made, in the order they
 * were streamed. These rows carry `streaming`, and nothing else does.
 */
function appendLive(
  rows: Row[],
  toolIndex: Map<string, number>,
  live: readonly LiveMessage[]
): void {
  for (const message of live) {
    // Trimmed as the durable path trims it, and for the same reason; a delta
    // that is only the closing newline must not push the prose down a line.
    const thinking = message.thinking.trim();
    if (message.text !== "" || thinking !== "") {
      rows.push({
        kind: "message",
        id: message.messageId,
        role: "assistant",
        text: message.text,
        // Never written, so never stamped; assistant rows do not draw one.
        timestamp: 0,
        ...(thinking === "" ? {} : { thinking }),
        streaming: true,
      });
    }
    for (const tool of message.tools) {
      upsertTool(rows, toolIndex, {
        kind: "tool",
        id: tool.callId,
        name: tool.name,
        view: tool.view,
        isError: tool.isError,
        isPartial: tool.isPartial,
      });
    }
  }
}

export function buildRows(events: readonly DurableEvent[]): RowBuild {
  const rows: Row[] = [];
  const toolIndex = new Map<string, number>();
  for (const event of events) {
    append(rows, toolIndex, event);
  }
  return { rows, toolIndex };
}

/**
 * Continues a build with this client's unacknowledged messages and the live
 * turn, copying it first so the base — a memo of the whole durable log — is
 * never mutated. The copy is shallow, which is the point: on a text delta the
 * durable row objects keep their identity, and only the trailing rows are
 * rebuilt.
 */
export function extendRows(
  base: RowBuild,
  trailing: readonly DurableEvent[],
  live: readonly LiveMessage[] = []
): readonly Row[] {
  if (trailing.length === 0 && live.length === 0) {
    return base.rows;
  }
  const rows = [...base.rows];
  const toolIndex = new Map(base.toolIndex);
  for (const event of trailing) {
    append(rows, toolIndex, event);
  }
  appendLive(rows, toolIndex, live);
  return rows;
}

export function toRows(
  events: readonly DurableEvent[],
  trailing: readonly DurableEvent[] = [],
  live: readonly LiveMessage[] = []
): readonly Row[] {
  return extendRows(buildRows(events), trailing, live);
}
