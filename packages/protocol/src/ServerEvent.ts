import type { DirectoryListing } from "#core/shared/Directories";
import type { CommitResult, GitBranch } from "#core/shared/Git";
import type { PickerItem } from "#core/picker/PickerItem";
import type { LeaseFrontend } from "#core/session/SessionLease";
import type { UpdateSkip } from "#core/shared/Updater";
import type { NoticeSeverity, ToolView } from "#core/view/ViewBlock";
import type { ChangeList, FileDiff, FileLines } from "./Diff";
import type { ProtocolVersion } from "./Protocol";

export type SessionStatus = "idle" | "thinking" | "streaming" | "tool";

export type TurnStats = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly durationMs: number;
};

export type ToolCallView = {
  readonly callId: string;
  readonly name: string;
  readonly view: ToolView;
};

/** A file a user message carried; `url` is server-relative. */
export type AttachmentView = {
  /** What to call it on screen; never a path. */
  readonly name: string;
  readonly url: string;
  readonly isImage: boolean;
};

/** Projected from pi's session JSONL; `seq` is the line ordinal, so one line must emit at most one durable event and a client resumes at `seq > n`. */
export type DurableEvent =
  | {
      readonly seq: number;
      readonly type: "message";
      readonly messageId: string;
      readonly role: "user" | "assistant";
      readonly text: string;
      /** When pi appended the entry, in epoch ms. */
      readonly timestamp: number;
      readonly thinking?: string;
      /** Only ever set on a user message, which may carry nothing else. */
      readonly attachments?: readonly AttachmentView[];
      readonly toolCalls?: readonly ToolCallView[];
      /** The model call failed, with what it said; only ever set on an assistant message. */
      readonly error?: string;
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

/** Progress of the one `reload` this server can have in flight. */
export type UpdateStateEvent =
  | {
      readonly type: "update_state";
      readonly phase: "step";
      readonly label: string;
    }
  | {
      readonly type: "update_state";
      readonly phase: "restarting";
      readonly from: string;
      readonly to: string;
      readonly skipped: readonly UpdateSkip[];
    }
  /** New code is on disk but nothing will restart this process: no supervisor owns it. */
  | {
      readonly type: "update_state";
      readonly phase: "stranded";
      readonly from: string;
      readonly to: string;
      readonly skipped: readonly UpdateSkip[];
    }
  | {
      readonly type: "update_state";
      readonly phase: "failed";
      readonly error: string;
    };

/** Unsequenced live state, never replayed by ordinal; live `tool_call`s reappear in a durable message's `toolCalls`, so dedupe on `callId`. */
export type EphemeralEvent =
  | {
      readonly type: "attached";
      readonly protocolVersion: ProtocolVersion;
      readonly sessionId: string;
      readonly cwd: string;
      /** Highest durable `seq` at attach time; replay follows immediately. */
      readonly head: number;
      readonly pimVersion: string;
      readonly piVersion: string;
    }
  /** Several events in one frame; apply them in order, each as if it had arrived alone. */
  | { readonly type: "replay"; readonly events: readonly StreamEvent[] }
  | {
      readonly type: "message_start";
      readonly role: "assistant";
      readonly messageId: string;
    }
  /** Drop the live message with this id; the durable `message` superseding it was sent immediately before. */
  | { readonly type: "message_retire"; readonly messageId: string }
  | {
      readonly type: "text_delta";
      readonly messageId: string;
      readonly delta: string;
    }
  | {
      readonly type: "thinking_delta";
      readonly messageId: string;
      readonly delta: string;
    }
  | {
      readonly type: "tool_call";
      readonly callId: string;
      readonly name: string;
      readonly messageId: string;
      readonly view: ToolView;
    }
  | {
      readonly type: "tool_update";
      readonly callId: string;
      readonly view: ToolView;
    }
  /** Settled view until pi appends the `tool_result` for the same `callId`, which supersedes it. */
  | {
      readonly type: "tool_end";
      readonly callId: string;
      readonly view: ToolView;
      readonly isError: boolean;
    }
  /** Every picker answer a client holds for this cwd is stale; drop the cache and re-query. */
  | {
      readonly type: "picker_invalidate";
      readonly scope: "files" | "commands" | "all";
      readonly cwd: string;
    }
  /** A child's events, applied against the child's transcript; sent only to the connection that asked, and never resumed. */
  | {
      readonly type: "subagent_events";
      /** The parent tool call the watch was opened on. */
      readonly callId: string;
      readonly events: readonly StreamEvent[];
    }
  | { readonly type: "turn_end"; readonly stats: TurnStats }
  /** Sent to every connection, not just those attached; only sessions this server holds open are reported. */
  | {
      readonly type: "session_activity";
      readonly sessionId: string;
      readonly status: SessionStatus;
    }
  /** Sent to every connection; the read cursor is one per session, not one per client. */
  | { readonly type: "session_read"; readonly sessionId: string }
  /** Sent to every connection: the sessions on disk changed, so any listing a client holds is stale. */
  | { readonly type: "sessions_changed" }
  /** Sent to every connection; the restart it ends in drops every socket. */
  | UpdateStateEvent
  | {
      readonly type: "session_state";
      readonly cwd: string;
      readonly model: string;
      /** Display name for `model`; absent until one resolves. */
      readonly modelLabel?: string;
      readonly thinking: string;
      readonly cost: number;
      readonly status: SessionStatus;
      /** False while another process holds this session's turn lease. */
      readonly writable: boolean;
      /** A session in the same working directory is mid-turn, so nothing may move the repository under it. */
      readonly repoBusy?: boolean;
      /** Who holds it; absent when nothing does, or when their record is torn. */
      readonly heldBy?: {
        readonly frontend: LeaseFrontend;
        readonly pid: number;
      };
      readonly tps?: number;
      /** Elapsed run time of the turn in flight, by the server's clock; absent when idle. */
      readonly turnElapsedMs?: number;
      /** Context filled, 0–100. Absent until a turn has reported usage. */
      readonly contextPercent?: number;
      readonly contextWindow?: number;
      /** The cwd's git branch, absent outside a repository. */
      readonly branch?: string;
      /** Paths git reports as changed; zero is a clean tree. */
      readonly dirtyCount?: number;
      readonly ahead?: number;
      readonly behind?: number;
    }
  /** A frame the server could not attribute to any command. */
  | { readonly type: "error"; readonly message: string };

/** One row of the session catalogue. */
export type SessionSummaryView = {
  readonly sessionId: string;
  readonly cwd: string;
  readonly createdAt: number;
  /** End of the last completed turn and the catalogue's sort key, never the file mtime; falls back to `createdAt`. */
  readonly settledAt: number;
  /** The session's first user message, trimmed; absent when it has none. */
  readonly title?: string;
  /** Has answered since anything last read it; absent means it has not. */
  readonly unread?: boolean;
  /** Absent when idle, and for a session this server does not hold open. */
  readonly status?: SessionStatus;
};

/** One model the server can be switched to, for the composer's model menu. */
export type ModelView = {
  readonly id: string;
  readonly label: string;
  /** The provider half of `id`, so a client can tag a row without parsing it. */
  readonly provider: string;
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
  /** The model catalogue, for `list_models`. */
  readonly models?: readonly ModelView[];
  /** What the *current* model supports, on the same answer. */
  readonly thinkingLevels?: readonly string[];
  /** One directory's subdirectories, for `list_dirs`. */
  readonly directory?: DirectoryListing;
  /** The cwd's local branches, for `list_branches`. */
  readonly branches?: readonly GitBranch[];
  /** The commit that landed, for `commit`. */
  readonly commit?: Pick<Extract<CommitResult, { readonly ok: true }>, "sha">;
  /** The change list, for `list_changes`. */
  readonly changes?: ChangeList;
  /** One file's hunks, for `file_diff`. */
  readonly fileDiff?: FileDiff;
  /** The lines behind one gap, for `read_lines`. */
  readonly fileLines?: FileLines;
  /** For `cancel` and `dequeue`: queued messages pi gave back, now owned by the client that asked. */
  readonly restored?: readonly string[];
};

export type ServerEvent = DurableEvent | EphemeralEvent | ResponseEvent;

/** Anything a session emits: everything on the wire but an answer to a command. */
export type StreamEvent = DurableEvent | EphemeralEvent;

export type ServerEventType = ServerEvent["type"];

export function isDurableEvent(event: ServerEvent): event is DurableEvent {
  return "seq" in event;
}
