import type { PickerItem } from "#core/picker/PickerItem";
import type { NoticeSeverity, ToolView } from "#core/view/ViewBlock";
import type { ProtocolVersion } from "./Protocol";

/**
 * What the agent is doing right now. The spinner is presentation and stays a
 * frontend concern; the numbers are state and travel on the wire.
 */
export type SessionStatus = "idle" | "thinking" | "streaming" | "tool";

export type TurnStats = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly durationMs: number;
};

/** A tool call as it appears on a persisted assistant message. */
export type ToolCallView = {
  readonly callId: string;
  readonly name: string;
  readonly view: ToolView;
};

/**
 * Events projected from pi's session JSONL. `seq` **is** the physical line
 * ordinal of the entry they came from, unmodified, so a client resumes by asking for `seq > n`. One line produces at most one durable
 * event, which is what makes that cursor exact: a client that has processed
 * seq N has processed every byte of the log up to line N.
 *
 * The client never receives raw tool `content` — that is the model's channel.
 * It only ever sees a `ToolView` derived from it plus `details`.
 */
export type DurableEvent =
  | {
      readonly seq: number;
      readonly type: "message";
      readonly messageId: string;
      readonly role: "user" | "assistant";
      readonly text: string;
      readonly thinking?: string;
      readonly toolCalls?: readonly ToolCallView[];
    }
  | {
      readonly seq: number;
      readonly type: "tool_result";
      readonly callId: string;
      readonly name: string;
      readonly view: ToolView;
      readonly isError: boolean;
    }
  | {
      readonly seq: number;
      readonly type: "notice";
      readonly severity: NoticeSeverity;
      readonly text: string;
    };

/**
 * The live preview of the turn in flight, and the session state around it.
 * Deliberately **unsequenced**: none of it is persisted line by line, so none
 * of it can be replayed by ordinal. A reconnecting client is instead handed the
 * coalesced in-flight buffer — one `message_start` plus one `text_delta`
 * carrying everything streamed so far — and then the durable event supersedes
 * it once pi appends the finished message.
 *
 * A client renders these into a trailing "in flight" bucket and clears that
 * bucket whenever a durable `message` with `role: "assistant"` arrives. Live
 * `tool_call` events therefore re-appear inside that message's `toolCalls`;
 * dedupe on `callId`.
 */
export type EphemeralEvent =
  | {
      readonly type: "attached";
      readonly protocolVersion: ProtocolVersion;
      readonly sessionId: string;
      readonly cwd: string;
      /** Highest durable `seq` at attach time; replay follows immediately. */
      readonly head: number;
    }
  | {
      readonly type: "message_start";
      readonly role: "assistant";
      readonly messageId: string;
    }
  | {
      readonly type: "text_delta";
      readonly messageId: string;
      readonly delta: string;
    }
  | {
      readonly type: "tool_call";
      readonly callId: string;
      readonly name: string;
      readonly view: ToolView;
    }
  | {
      readonly type: "tool_update";
      readonly callId: string;
      readonly view: ToolView;
    }
  /**
   * A tool call the server refuses to run unattended — the top tier of the
   * approval policy. The turn is blocked until some client answers with
   * `approve_tool`, so this is re-sent in the in-flight snapshot on every
   * attach: a client that connects an hour later still sees the question.
   */
  | {
      readonly type: "approval_request";
      readonly callId: string;
      readonly name: string;
      readonly view: ToolView;
      /** Why the policy could not decide on its own, in plain words. */
      readonly reason: string;
    }
  /**
   * The pending request for `callId` is gone. Broadcast to every attached
   * client, including the one that answered, so a second client's prompt
   * clears instead of hanging on a question nobody can answer any more.
   */
  | {
      readonly type: "approval_resolved";
      readonly callId: string;
      readonly approved: boolean;
      readonly reason: string;
    }
  /**
   * Every picker answer this session's clients hold is stale: the cwd moved,
   * or a tool wrote to it. Clients drop their result cache and re-query on the
   * next keystroke; the catalog itself never leaves the server.
   */
  | {
      readonly type: "picker_invalidate";
      readonly scope: "files" | "commands" | "all";
      readonly cwd: string;
    }
  | { readonly type: "turn_end"; readonly stats: TurnStats }
  | {
      readonly type: "session_state";
      readonly cwd: string;
      readonly model: string;
      readonly thinking: string;
      readonly cost: number;
      readonly status: SessionStatus;
      readonly tps?: number;
    }
  /** A frame the server could not attribute to any command. */
  | { readonly type: "error"; readonly message: string };

/**
 * One row of the session catalogue. Pi's own on-disk grouping, keyed on its
 * session UUID — the server's path to the JSONL is
 * deliberately not here, because a client has no use for it and no filesystem
 * to resolve it against.
 */
export type SessionSummaryView = {
  readonly sessionId: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly modifiedAt: number;
};

/** Answer to one `Command`, correlated by its `id`. Never sequenced. */
export type ResponseEvent = {
  readonly type: "response";
  readonly id: string;
  readonly success: boolean;
  readonly error?: string;
  /** Ranked rows, for the commands that answer with data (`pick_*`). */
  readonly items?: readonly PickerItem[];
  /** The catalogue, for `list_sessions`. */
  readonly sessions?: readonly SessionSummaryView[];
};

export type ServerEvent = DurableEvent | EphemeralEvent | ResponseEvent;

export type ServerEventType = ServerEvent["type"];

export function isDurableEvent(event: ServerEvent): event is DurableEvent {
  return "seq" in event;
}
