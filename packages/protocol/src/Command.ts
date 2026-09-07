import type { ProtocolVersion } from "./Protocol";

/**
 * A file the client has already transferred into the server's world via
 * `POST /upload`, named by the id that endpoint answered with. Never a
 * client-local path: the agent has exactly one filesystem and it is the
 * server's, so the client's own path for the bytes is
 * meaningless here and must never reach the conversation.
 */
export type AttachmentRef = {
  readonly id: string;
};

/** Client → server. Every command carries an `id` so its response correlates. */
export type Command =
  /**
   * Opening frame of every connection. Omit `sessionId` to start a new
   * session in `cwd` — pi assigns the UUID, which comes back on `attached`.
   */
  | {
      readonly id: string;
      readonly type: "attach";
      readonly protocolVersion: ProtocolVersion;
      readonly sessionId?: string;
      readonly cwd?: string;
      readonly fromSeq: number;
    }
  /**
   * Says the message. Sent into a turn already running it steers that turn:
   * it reaches the agent after the tool calls in flight and before the next
   * model call, rather than waiting for the whole turn to end.
   */
  | {
      readonly id: string;
      readonly type: "user_message";
      readonly sessionId: string;
      readonly text: string;
      readonly attachments?: readonly AttachmentRef[];
    }
  | { readonly id: string; readonly type: "cancel"; readonly sessionId: string }
  /**
   * Take back what the turn in flight is still holding, without stopping it.
   * The messages come back on `restored`, and the client that asked owns them
   * from there — this is a reader reclaiming something said but not yet
   * heard, in order to say it differently.
   */
  | {
      readonly id: string;
      readonly type: "dequeue";
      readonly sessionId: string;
    }
  | {
      readonly id: string;
      readonly type: "pick_files";
      readonly sessionId: string;
      readonly query: string;
      readonly limit: number;
    }
  | {
      readonly id: string;
      readonly type: "pick_commands";
      readonly sessionId: string;
      readonly query: string;
      readonly limit?: number;
    }
  | {
      readonly id: string;
      readonly type: "set_cwd" | "set_model" | "set_thinking";
      readonly sessionId: string;
      readonly value: string;
    }
  /**
   * The session catalogue, read straight off pi's sessions directory. Answers
   * before any `attach`, because picking a session is what a client does
   * *instead of* already having one.
   */
  | {
      readonly id: string;
      readonly type: "list_sessions";
      /** Restrict to one working directory; omit for every session on disk. */
      readonly cwd?: string;
      readonly limit?: number;
    }
  /**
   * The models this server can switch to, plus the thinking levels the model
   * it is on supports. Like `list_sessions` it answers without a session,
   * because the catalogue is a property of the machine, not of a conversation.
   */
  | { readonly id: string; readonly type: "list_models" }
  /**
   * Run the latest code: update this install and restart it, whether or not
   * the update moved anything. Unconditional because the operator is asking
   * to be on the new version, not asking whether there is one.
   *
   * Carries no session for the same reason `list_models` does not — it is a
   * fact about the machine — and it takes every session on that machine down
   * with it, which is why it is refused while any of them is mid-turn.
   * `force` says to kill those turns anyway.
   */
  | { readonly id: string; readonly type: "reload"; readonly force?: boolean };

export type CommandType = Command["type"];

/**
 * A command before the transport stamps its correlation id. Distributive, so
 * each member keeps its own fields instead of collapsing to the shared ones.
 */
export type CommandDraft = Command extends infer T
  ? T extends Command
    ? Omit<T, "id">
    : never
  : never;
