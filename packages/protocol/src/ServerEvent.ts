import type { ToolView } from "../../core/src/view/ViewBlock";

/**
 * What the agent is doing right now. The spinner is presentation and stays a
 * frontend concern; the numbers are state and travel on the wire
 * (Resolved Decision 5).
 */
export type SessionStatus = "idle" | "thinking" | "streaming" | "tool";

export type TurnStats = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly durationMs: number;
};

/**
 * Server → client.
 *
 * `seq` **is** pi's own JSONL mutation seq, unmodified — we do not renumber and
 * we do not keep a second store (Resolved Decision 2). A client resumes by
 * replaying `seq > N`. Command responses carry no `seq` because they change no
 * state.
 *
 * `text_delta` is ephemeral: never persisted individually, so on reconnect the
 * server sends the coalesced in-flight buffer as one block instead.
 *
 * The client never receives raw tool `content` — that is the model's channel.
 * It only ever sees a `ToolView` derived from `details`.
 */
export type ServerEvent =
  | {
      readonly seq: number;
      readonly type: "message_start";
      readonly role: "user" | "assistant";
      readonly messageId: string;
    }
  | {
      readonly seq: number;
      readonly type: "text_delta";
      readonly messageId: string;
      readonly delta: string;
    }
  | {
      readonly seq: number;
      readonly type: "tool_call";
      readonly callId: string;
      readonly name: string;
      readonly view: ToolView;
    }
  | {
      readonly seq: number;
      readonly type: "tool_update";
      readonly callId: string;
      readonly view: ToolView;
    }
  | {
      readonly seq: number;
      readonly type: "tool_result";
      readonly callId: string;
      readonly view: ToolView;
      readonly isError: boolean;
    }
  | {
      readonly seq: number;
      readonly type: "approval_request";
      readonly callId: string;
      readonly name: string;
      readonly view: ToolView;
    }
  | {
      readonly seq: number;
      readonly type: "turn_end";
      readonly stats: TurnStats;
    }
  | {
      readonly seq: number;
      readonly type: "session_state";
      readonly cwd: string;
      readonly model: string;
      readonly thinking: string;
      readonly cost: number;
      readonly status: SessionStatus;
      readonly tps?: number;
    }
  | { readonly seq: number; readonly type: "picker_invalidate" }
  | {
      readonly type: "response";
      readonly id: string;
      readonly success: boolean;
      readonly error?: string;
    };

export type ServerEventType = ServerEvent["type"];
