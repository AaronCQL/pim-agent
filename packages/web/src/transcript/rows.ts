import type { ToolView } from "#core/view/ViewBlock";
import type { AttachmentView, DurableEvent } from "#protocol/ServerEvent";
import type { LiveMessage, PendingMessage } from "../session/SessionStore";

export type MessageRow = {
  readonly kind: "message";
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly timestamp: number;
  readonly attachments?: readonly AttachmentView[];
  readonly thinking?: string;
  readonly streaming?: boolean;
  readonly queued?: boolean;
};

export type ToolRow = {
  readonly kind: "tool";
  readonly id: string;
  readonly name: string;
  readonly view: ToolView;
  readonly isError: boolean;
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

// A call is sighted more than once on the wire; dedupe on `callId` and upgrade in place.
function append(
  rows: Row[],
  toolIndex: Map<string, number>,
  event: DurableEvent
): void {
  switch (event.type) {
    case "message": {
      // Trimmed: the block is `whitespace-pre-wrap`, and models end reasoning
      // with newlines.
      const thinking = event.thinking?.trim() ?? "";
      const attachments = event.attachments ?? [];
      if (event.text !== "" || thinking !== "" || attachments.length > 0) {
        rows.push({
          kind: "message",
          id: event.messageId,
          role: event.role,
          text: event.text,
          timestamp: event.timestamp,
          ...(attachments.length === 0 ? {} : { attachments }),
          ...(thinking === "" ? {} : { thinking }),
        });
      }
      if (event.error !== undefined) {
        rows.push({
          kind: "notice",
          id: `${event.messageId}-error`,
          severity: "error",
          text: event.error,
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

// A settled row is never downgraded back to partial by a re-stated call.
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

function appendLive(
  rows: Row[],
  toolIndex: Map<string, number>,
  live: readonly LiveMessage[]
): void {
  for (const message of live) {
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

function pushPending(rows: Row[], pending: PendingMessage): void {
  rows.push({
    kind: "message",
    id: pending.id,
    role: "user",
    text: pending.text,
    timestamp: pending.timestamp,
    ...(pending.attachments === undefined
      ? {}
      : { attachments: pending.attachments }),
    ...(pending.queued ? { queued: true } : {}),
  });
}

/**
 * Continues a build with this client's unacknowledged messages and the live
 * turn. The copy is shallow, so durable rows keep their identity across a
 * delta; a message queued into a running turn sits below it.
 */
export function extendRows(
  base: RowBuild,
  trailing: readonly PendingMessage[],
  live: readonly LiveMessage[] = []
): readonly Row[] {
  if (trailing.length === 0 && live.length === 0) {
    return base.rows;
  }
  const rows = [...base.rows];
  const toolIndex = new Map(base.toolIndex);
  for (const pending of trailing) {
    if (!pending.queued) {
      pushPending(rows, pending);
    }
  }
  appendLive(rows, toolIndex, live);
  for (const pending of trailing) {
    if (pending.queued) {
      pushPending(rows, pending);
    }
  }
  return rows;
}

export function toRows(
  events: readonly DurableEvent[],
  trailing: readonly PendingMessage[] = [],
  live: readonly LiveMessage[] = []
): readonly Row[] {
  return extendRows(buildRows(events), trailing, live);
}
