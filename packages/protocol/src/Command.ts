import type { DiffBase, LineSpan } from "./Diff";

/** A file already uploaded via `POST /upload`. */
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
      /** Copy model, thinking level and cwd from this session; ignored when `sessionId` is set or it is not open. */
      readonly like?: string;
      readonly fromSeq: number;
      /** Absent means true. */
      readonly attentive?: boolean;
    }
  /** An inattentive connection never marks a turn as read. */
  | { readonly id: string; readonly type: "attention"; readonly value: boolean }
  /** Sent mid-turn, it steers the running turn. */
  | {
      readonly id: string;
      readonly type: "user_message";
      readonly sessionId: string;
      readonly text: string;
      readonly attachments?: readonly AttachmentRef[];
    }
  | { readonly id: string; readonly type: "cancel"; readonly sessionId: string }
  /** Take back queued messages without stopping the turn; returned in `restored`. */
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
  /** Works before any `attach`. */
  | {
      readonly id: string;
      readonly type: "list_sessions";
      readonly cwd?: string;
      readonly limit?: number;
      /** Max sessions per working directory. */
      readonly perProject?: number;
      readonly archived?: boolean;
    }
  /** An empty `query` warms the index and returns no hits. */
  | {
      readonly id: string;
      readonly type: "search_sessions";
      readonly query: string;
      readonly limit?: number;
      readonly cwd?: string;
      /** Omitted searches everything; `false` excludes archived, `true` searches only archived. */
      readonly archived?: boolean;
    }
  /** Written as pi's `session_info`; `null` clears it. */
  | {
      readonly id: string;
      readonly type: "set_session_name";
      readonly sessionId: string;
      readonly value: string | null;
    }
  | {
      readonly id: string;
      readonly type: "set_session_archived" | "set_session_unread";
      readonly sessionId: string;
      readonly value: boolean;
    }
  | {
      readonly id: string;
      readonly type: "set_project_pinned" | "set_project_expanded";
      readonly cwd: string;
      readonly value: boolean;
    }
  /** Display label only; `null` clears it. */
  | {
      readonly id: string;
      readonly type: "set_project_label";
      readonly cwd: string;
      readonly value: string | null;
    }
  /** The full pinned order; last write wins. */
  | {
      readonly id: string;
      readonly type: "set_pin_order";
      readonly order: readonly string[];
    }
  /** Also returns the current model's thinking levels. */
  | { readonly id: string; readonly type: "list_models" }
  /** Read against the connection's cwd when it has one. */
  | { readonly id: string; readonly type: "list_extensions" }
  /** Sessions pick it up when they next rebuild their agent. */
  | {
      readonly id: string;
      readonly type: "set_extension";
      readonly extensionId: string;
      readonly value: boolean;
    }
  /** Errors when `path` is not a readable directory. */
  | { readonly id: string; readonly type: "list_dirs"; readonly path: string }
  /** Parent must exist. */
  | { readonly id: string; readonly type: "create_dir"; readonly path: string }
  /** `fetch` fetches the remote first, updating ahead/behind. */
  | {
      readonly id: string;
      readonly type: "refresh_git";
      readonly sessionId: string;
      readonly fetch?: boolean;
    }
  /** Trunk first, then most recent. */
  | {
      readonly id: string;
      readonly type: "list_branches";
      readonly sessionId: string;
    }
  /** Files only, no hunks. Allowed mid-turn. */
  | {
      readonly id: string;
      readonly type: "list_changes";
      readonly sessionId: string;
      readonly base: DiffBase;
    }
  /** `context` defaults to 3. */
  | {
      readonly id: string;
      readonly type: "file_diff";
      readonly sessionId: string;
      readonly base: DiffBase;
      readonly path: string;
      readonly context?: number;
    }
  /** Lines in the gaps between hunks. */
  | {
      readonly id: string;
      readonly type: "read_lines";
      readonly sessionId: string;
      readonly base: DiffBase;
      readonly path: string;
      readonly spans: readonly LineSpan[];
    }
  /** Refused while any session in the same cwd is mid-turn. */
  | {
      readonly id: string;
      readonly type: "checkout";
      readonly sessionId: string;
      readonly branch: string;
    }
  /** `pull` is fast-forward only; `push` sets the upstream on first publish. */
  | {
      readonly id: string;
      readonly type: "pull" | "push";
      readonly sessionId: string;
    }
  /** Commits exactly `paths`. Refused mid-turn, like `checkout`. */
  | {
      readonly id: string;
      readonly type: "commit";
      readonly sessionId: string;
      readonly message: string;
      /** Include both names of a renamed file. */
      readonly paths: readonly string[];
    }
  /** `callId` is the parent's tool call; `sessionId` must be this connection's session. */
  | {
      readonly id: string;
      readonly type: "watch_subagent";
      readonly sessionId: string;
      readonly callId: string;
      readonly fromSeq: number;
    }
  /** Succeeds even if nothing is watched. */
  | {
      readonly id: string;
      readonly type: "unwatch_subagent";
      readonly callId: string;
    }
  /** Update and restart; refused while any session is mid-turn unless `force`. */
  | { readonly id: string; readonly type: "reload"; readonly force?: boolean }
  /** Answers a `ui_request`; refused once it is settled. */
  | {
      readonly id: string;
      readonly type: "ui_response";
      readonly sessionId: string;
      readonly requestId: string;
      readonly value?: string;
      readonly confirmed?: boolean;
      readonly cancelled?: boolean;
    };

export type CommandType = Command["type"];

/** A command before the transport stamps its correlation id. */
export type CommandDraft = Command extends infer T
  ? T extends Command
    ? Omit<T, "id">
    : never
  : never;

/** The `list_sessions` payload. */
export type SessionScope = Omit<
  Extract<CommandDraft, { readonly type: "list_sessions" }>,
  "type"
>;

/** The `search_sessions` payload without `query`. */
export type SearchScope = Omit<
  Extract<CommandDraft, { readonly type: "search_sessions" }>,
  "type" | "query"
>;
