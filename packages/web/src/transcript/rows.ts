import { JobState } from "#core/extensions/subagent/JobState";
import type { ToolView } from "#core/view/ViewBlock";
import type {
  AttachmentView,
  DurableEvent,
  SubagentChildView,
} from "#protocol/ServerEvent";
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
  /** The call id whose subagent log the row opens. */
  readonly child?: string;
  /** The job's short name, `j3`. */
  readonly handle?: string;
  /** Set on a background subagent's result. */
  readonly state?: JobState;
};

export type NoticeRow = {
  readonly kind: "notice";
  readonly id: string;
  readonly severity: "info" | "warn" | "error";
  readonly text: string;
};

/** A running job's context notice: one muted line, not a card. */
export type JobNoticeRow = {
  readonly kind: "job_notice";
  readonly id: string;
  readonly text: string;
};

export type Row = MessageRow | ToolRow | NoticeRow | JobNoticeRow;

export type RowBuild = {
  readonly rows: readonly Row[];
  readonly toolIndex: ReadonlyMap<string, number>;
};

// A tool call can arrive more than once; dedupe on `callId`.
function append(
  rows: Row[],
  toolIndex: Map<string, number>,
  event: DurableEvent
): void {
  switch (event.type) {
    case "message": {
      // Models end reasoning with newlines.
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
      if (event.skill !== undefined) {
        rows.push({
          kind: "tool",
          id: `${event.messageId}-skill`,
          name: "skill",
          view: {
            label: "Skill",
            title: [{ kind: "text", text: event.skill.name }],
            body: [{ kind: "markdown", text: event.skill.content }],
          },
          isError: false,
          isPartial: false,
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
        upsertTool(rows, toolIndex, toolRow(call, false, true));
      }
      break;
    }
    case "tool_result": {
      upsertTool(rows, toolIndex, toolRow(event, event.isError, false));
      break;
    }
    case "subagent_result":
      upsertTool(rows, toolIndex, {
        kind: "tool",
        id: event.messageId,
        name: "subagent",
        view: event.view,
        isError: JobState.isError(event.state),
        isPartial: false,
        child: event.jobId,
        ...(event.handle === undefined ? {} : { handle: event.handle }),
        state: event.state,
      });
      break;
    case "notice":
      rows.push({
        kind: "notice",
        id: `notice-${event.seq}`,
        severity: event.severity,
        text: event.text,
      });
      break;
    case "subagent_notice":
      rows.push({ kind: "job_notice", id: event.messageId, text: event.text });
      break;
  }
}

function toolRow(
  {
    callId,
    name,
    view,
    child,
  }: {
    readonly callId: string;
    readonly name: string;
    readonly view: ToolView;
    readonly child?: SubagentChildView | undefined;
  },
  isError: boolean,
  isPartial: boolean
): ToolRow {
  return {
    kind: "tool",
    id: callId,
    name,
    view,
    isError,
    isPartial,
    ...(child === undefined ? {} : { child: child.jobId }),
    ...(child?.handle === undefined ? {} : { handle: child.handle }),
  };
}

// Never downgrades a settled row back to partial.
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
        timestamp: 0,
        ...(thinking === "" ? {} : { thinking }),
        streaming: true,
      });
    }
    for (const tool of message.tools) {
      upsertTool(rows, toolIndex, toolRow(tool, tool.isError, tool.isPartial));
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

/** Appends pending messages and the live turn; queued messages go below the live turn. Durable rows keep their identity. */
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
