import type { ProtocolVersion } from "./Protocol";

/** A file already uploaded via `POST /upload`, by the id that endpoint answered with; never a client-local path. */
export type AttachmentRef = {
  readonly id: string;
};

/** Client → server. Every command carries an `id` so its response correlates. */
export type Command =
  /** Opening frame of every connection; omit `sessionId` to start a new session in `cwd`. */
  | {
      readonly id: string;
      readonly type: "attach";
      readonly protocolVersion: ProtocolVersion;
      readonly sessionId?: string;
      readonly cwd?: string;
      /** Copy model, thinking level and cwd from this session; ignored when `sessionId` is set or the session is not held open. */
      readonly like?: string;
      readonly fromSeq: number;
    }
  /** Sent into a running turn it steers that turn, landing before the next model call. */
  | {
      readonly id: string;
      readonly type: "user_message";
      readonly sessionId: string;
      readonly text: string;
      readonly attachments?: readonly AttachmentRef[];
    }
  | { readonly id: string; readonly type: "cancel"; readonly sessionId: string }
  /** Take back the queued messages without stopping the turn; they come back on `restored`. */
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
  /** The session catalogue; answers before any `attach`. */
  | {
      readonly id: string;
      readonly type: "list_sessions";
      /** Restrict to one working directory; omit for every session on disk. */
      readonly cwd?: string;
      readonly limit?: number;
    }
  /** The models this server can switch to, plus the current model's thinking levels; answers without a session. */
  | { readonly id: string; readonly type: "list_models" }
  /** Subdirectories of `path` on the server's filesystem; errors rather than answering empty when it is not a readable directory. */
  | { readonly id: string; readonly type: "list_dirs"; readonly path: string }
  /** Re-read the cwd's git state now; `fetch` asks the remote first, which is the only thing that moves ahead and behind. */
  | {
      readonly id: string;
      readonly type: "refresh_git";
      readonly sessionId: string;
      readonly fetch?: boolean;
    }
  /** The cwd's local branches, trunk first and the rest by how recently they were worked on. */
  | {
      readonly id: string;
      readonly type: "list_branches";
      readonly sessionId: string;
    }
  /** Refused while any session in the same directory is mid-turn: the agent may be halfway through an edit. */
  | {
      readonly id: string;
      readonly type: "checkout";
      readonly sessionId: string;
      readonly branch: string;
    }
  /** `pull` is fast-forward only; `push` adopts an upstream the first time a branch is published. */
  | {
      readonly id: string;
      readonly type: "pull" | "push";
      readonly sessionId: string;
    }
  /** Read-only view of a subagent's transcript; `callId` is the parent's tool call and `sessionId` must be this connection's session. */
  | {
      readonly id: string;
      readonly type: "watch_subagent";
      readonly sessionId: string;
      readonly callId: string;
      readonly fromSeq: number;
    }
  /** Stop watching; succeeds whether or not this connection holds the watch. */
  | {
      readonly id: string;
      readonly type: "unwatch_subagent";
      readonly callId: string;
    }
  /** Update this install and restart it unconditionally; refused while any session is mid-turn unless `force`. */
  | { readonly id: string; readonly type: "reload"; readonly force?: boolean };

export type CommandType = Command["type"];

/** A command before the transport stamps its correlation id. */
export type CommandDraft = Command extends infer T
  ? T extends Command
    ? Omit<T, "id">
    : never
  : never;
