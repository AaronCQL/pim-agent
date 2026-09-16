import type { DiffBase, LineSpan } from "./Diff";

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
      readonly sessionId?: string;
      readonly cwd?: string;
      /** Copy model, thinking level and cwd from this session; ignored when `sessionId` is set or the session is not held open. */
      readonly like?: string;
      readonly fromSeq: number;
      /** Whether the client is looking at this session right now; absent means yes. */
      readonly attentive?: boolean;
    }
  /** Whether this connection's reader is present: an inattentive one never consumes a turn as read. */
  | { readonly id: string; readonly type: "attention"; readonly value: boolean }
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
      /** Keep at most this many sessions per working directory, so one busy project cannot fill the page. */
      readonly perProject?: number;
      /** List the archived sessions instead of the live ones. */
      readonly archived?: boolean;
    }
  /** Ranked search over every session on disk, titles and what was said; an empty `query` warms the index and answers with no hits. */
  | {
      readonly id: string;
      readonly type: "search_sessions";
      readonly query: string;
      readonly limit?: number;
      /** Restrict to one working directory; omit for every session on disk. */
      readonly cwd?: string;
      /** Omitted, the archived are searched too and their hits say so; `false` leaves them out, `true` searches only them. */
      readonly archived?: boolean;
    }
  /** Names a session through pi's own `session_info`, so its terminal picker shows the name too; `null` clears it. */
  | {
      readonly id: string;
      readonly type: "set_session_name";
      readonly sessionId: string;
      readonly value: string | null;
    }
  /** pim's own overrides on a session: out of the default listing, or held unread until it is answered. */
  | {
      readonly id: string;
      readonly type: "set_session_archived" | "set_session_unread";
      readonly sessionId: string;
      readonly value: boolean;
    }
  /**
   * pim's own overrides on a working directory rather than a session: pinned
   * sorts it above every other, expanded stands its sidebar group unfolded.
   */
  | {
      readonly id: string;
      readonly type: "set_project_pinned" | "set_project_expanded";
      readonly cwd: string;
      readonly value: boolean;
    }
  /** Re-orders the pinned projects. The whole order, never a move: two surfaces settle on the last one sent. */
  | {
      readonly id: string;
      readonly type: "set_pin_order";
      readonly order: readonly string[];
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
  /** Every changed file of one diff base, without a hunk of any of them; read-only, so never refused. */
  | {
      readonly id: string;
      readonly type: "list_changes";
      readonly sessionId: string;
      readonly base: DiffBase;
    }
  /** One file's hunks, computed only once a reader expands it; `context` defaults to 3. */
  | {
      readonly id: string;
      readonly type: "file_diff";
      readonly sessionId: string;
      readonly base: DiffBase;
      readonly path: string;
      readonly context?: number;
    }
  /** The file's own lines behind a gap between hunks, asked for when a reader opens one. */
  | {
      readonly id: string;
      readonly type: "read_lines";
      readonly sessionId: string;
      readonly base: DiffBase;
      readonly path: string;
      readonly spans: readonly LineSpan[];
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
  /** Path-limited: exactly `paths` are staged and committed, everything else changed stays dirty. Refused mid-turn, like `checkout`. */
  | {
      readonly id: string;
      readonly type: "commit";
      readonly sessionId: string;
      readonly message: string;
      /** A renamed file contributes both of its names, or its old one is left behind. */
      readonly paths: readonly string[];
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
