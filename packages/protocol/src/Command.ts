import type { ProtocolVersion } from "./Protocol";

/**
 * A file the client has already transferred into the server's world via
 * `POST /upload`, named by the id that endpoint answered with. Never a
 * client-local path: the agent has exactly one filesystem and it is the
 * server's (Guiding Decision 8), so the client's own path for the bytes is
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
  | {
      readonly id: string;
      readonly type: "user_message";
      readonly sessionId: string;
      readonly text: string;
      readonly attachments?: readonly AttachmentRef[];
    }
  | {
      readonly id: string;
      readonly type: "steer";
      readonly sessionId: string;
      readonly text: string;
    }
  | { readonly id: string; readonly type: "cancel"; readonly sessionId: string }
  | {
      readonly id: string;
      readonly type: "approve_tool";
      readonly sessionId: string;
      readonly callId: string;
      readonly approved: boolean;
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
    };

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
