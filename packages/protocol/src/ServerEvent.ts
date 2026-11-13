import type { JobView } from "#core/extensions/subagent/SubagentJobs";
import type { JobState } from "#core/extensions/subagent/JobState";
import type { DirectoryListing } from "#core/shared/Directories";
import type { CommitResult, GitBranch } from "#core/shared/Git";
import type { PickerItem } from "#core/picker/PickerItem";
import type { ExtensionEntry } from "#core/shared/PiExtensions";
import type { SearchRange, SearchSnippet } from "#core/session/SearchIndex";
import type { LeaseFrontend } from "#core/session/SessionLease";
import type { SkillUse } from "#core/session/UserPrompt";
import type { UpdateSkip } from "#core/shared/Updater";
import type { NoticeSeverity, ToolView } from "#core/view/ViewBlock";
import type {
  ChangeList,
  FileContent,
  FileDiff,
  FileLines,
  FileList,
} from "./Diff";

export type SessionStatus = "idle" | "thinking" | "streaming" | "tool";

export type TurnStats = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly durationMs: number;
};

/** The subagent log a row opens: `watch_subagent` takes `jobId` as its `callId`. */
export type SubagentChildView = {
  readonly jobId: string;
  /** The job's short name in its session, `j3`; absent for a synchronous run. */
  readonly handle?: string;
};

export type ToolCallView = {
  readonly callId: string;
  readonly name: string;
  readonly view: ToolView;
  /** Set while the call owns, or may yet own, a subagent log. */
  readonly child?: SubagentChildView;
};

/** A file a user message carried; `url` is server-relative. */
export type AttachmentView = {
  /** Display name; never a path. */
  readonly name: string;
  readonly url: string;
  readonly isImage: boolean;
};

/** What pi holds queued behind the running turn, merged into one message. */
export type QueuedView = {
  readonly text: string;
  readonly attachments?: readonly AttachmentView[];
};

/** Projected from pi's session JSONL. `seq` is the line ordinal, so each line emits at most one durable event. */
export type DurableEvent =
  | {
      readonly seq: number;
      readonly type: "message";
      readonly messageId: string;
      readonly role: "user" | "assistant";
      readonly text: string;
      /** Epoch ms. */
      readonly timestamp: number;
      readonly thinking?: string;
      /** User messages only. */
      readonly attachments?: readonly AttachmentView[];
      /** User messages only; `text` then holds the command as typed. */
      readonly skill?: SkillUse;
      readonly toolCalls?: readonly ToolCallView[];
      /** Model call error; assistant messages only. */
      readonly error?: string;
    }
  | {
      readonly seq: number;
      readonly type: "tool_result";
      readonly callId: string;
      readonly name: string;
      readonly view: ToolView;
      readonly isError: boolean;
      /** Set on a spawn or a synchronous run that owns a subagent log; never on a failed one. */
      readonly child?: SubagentChildView;
      /** Absent when the tool did not run, or for results recorded before pi measured it. */
      readonly durationMs?: number;
    }
  | {
      readonly seq: number;
      readonly type: "notice";
      readonly severity: NoticeSeverity;
      readonly text: string;
    }
  /** A running background subagent's context reached a notice level. */
  | {
      readonly seq: number;
      readonly type: "subagent_notice";
      readonly messageId: string;
      /** The spawning call's `callId`; `watch_subagent` reads the child log under it. */
      readonly jobId: string;
      /** The job's short name in its session, `j3`. */
      readonly handle: string;
      readonly view: ToolView;
    }
  /** A background subagent's one result, appended after its `subagent` spawn call settled. */
  | {
      readonly seq: number;
      readonly type: "subagent_result";
      readonly messageId: string;
      /** The spawning call's `callId`; `watch_subagent` reads the child log under it. */
      readonly jobId: string;
      /** The job's short name in its session, `j3`. */
      readonly handle?: string;
      readonly state: JobState;
      readonly view: ToolView;
      /** Epoch ms. */
      readonly timestamp: number;
    };

/** Progress of a `reload`. */
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
  /** Updated on disk, but no supervisor will restart this process. */
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

/** Unsequenced live state. Live `tool_call`s reappear in a durable message's `toolCalls`, so dedupe on `callId`. */
export type EphemeralEvent =
  | {
      readonly type: "attached";
      readonly sessionId: string;
      readonly cwd: string;
      /** Highest durable `seq` at attach time. */
      readonly head: number;
      /** A client built from another version should reload. */
      readonly pimVersion: string;
      readonly piVersion: string;
    }
  /** Apply in order, as if each arrived alone. */
  | { readonly type: "replay"; readonly events: readonly StreamEvent[] }
  | {
      readonly type: "message_start";
      readonly role: "assistant";
      readonly messageId: string;
    }
  /** Drop this live message; its durable `message` was sent just before. */
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
      /** As in `ToolCallView`. */
      readonly child?: SubagentChildView;
    }
  /** Each update restates `child`; the latest event wins. */
  | {
      readonly type: "tool_update";
      readonly callId: string;
      readonly view: ToolView;
      readonly child?: SubagentChildView;
    }
  /** Superseded by the `tool_result` with the same `callId`. */
  | {
      readonly type: "tool_end";
      readonly callId: string;
      readonly view: ToolView;
      readonly isError: boolean;
      /** As in `tool_result`. */
      readonly child?: SubagentChildView;
      readonly durationMs?: number;
    }
  /** Cached picker answers for this cwd are stale. */
  | {
      readonly type: "picker_invalidate";
      readonly scope: "files" | "commands" | "all";
      readonly cwd: string;
    }
  /** Sent only to the watching connection; never resumed. */
  | {
      readonly type: "subagent_events";
      readonly callId: string;
      readonly events: readonly StreamEvent[];
    }
  | { readonly type: "turn_end"; readonly stats: TurnStats }
  /** The session's running background subagents, oldest first; replaces the previous list. */
  | { readonly type: "jobs"; readonly jobs: readonly JobView[] }
  /** Markdown from an extension; not written to the session. */
  | {
      readonly type: "ui_notice";
      readonly id: string;
      readonly severity: NoticeSeverity;
      readonly text: string;
      /** The command being dispatched, like `/login`. */
      readonly command?: string;
    }
  /** The first `ui_response` wins. */
  | {
      readonly type: "ui_request";
      readonly requestId: string;
      readonly method: "select" | "confirm" | "input";
      readonly title: string;
      readonly message?: string;
      readonly options?: readonly string[];
      readonly placeholder?: string;
      /** The command that asked, like `/login`. */
      readonly command?: string;
    }
  | { readonly type: "ui_request_done"; readonly requestId: string }
  /** Broadcast; only for sessions this server holds open. */
  | {
      readonly type: "session_activity";
      readonly sessionId: string;
      readonly status: SessionStatus;
      /** Running background subagents; absent when none. */
      readonly jobs?: number;
    }
  /** Broadcast; the read cursor is per session, not per client. */
  | { readonly type: "session_read"; readonly sessionId: string }
  /** Broadcast patch: only changed fields are set. */
  | {
      readonly type: "session_meta";
      readonly sessionId: string;
      /** `null` once cleared. */
      readonly name?: string | null;
      readonly archived?: boolean;
      readonly unread?: boolean;
    }
  /** Broadcast patch: only changed fields are set. */
  | {
      readonly type: "project_meta";
      readonly cwd: string;
      readonly pinned?: boolean;
      readonly expanded?: boolean;
      /** `null` once cleared. */
      readonly label?: string | null;
    }
  /** Broadcast. */
  | { readonly type: "pins_changed"; readonly order: readonly string[] }
  /** Broadcast. */
  | { readonly type: "sessions_changed" }
  /** Broadcast. */
  | { readonly type: "extensions_changed" }
  /** Broadcast. */
  | UpdateStateEvent
  | {
      readonly type: "session_state";
      readonly cwd: string;
      readonly model: string;
      /** Display name for `model`; absent until one resolves. */
      readonly modelLabel?: string;
      readonly thinking: string;
      /** What subagents run on; an absent field follows the main agent. */
      readonly subagent?: {
        readonly model?: string;
        readonly thinking?: string;
      };
      readonly cost: number;
      readonly status: SessionStatus;
      /** False while another process holds this session's turn lease. */
      readonly writable: boolean;
      /** A session in the same cwd is mid-turn or running subagents, so git actions are refused. */
      readonly repoBusy?: boolean;
      /** Absent when unheld or the lease record is corrupt. */
      readonly heldBy?: {
        readonly frontend: LeaseFrontend;
        readonly pid: number;
      };
      readonly tps?: number;
      /** Absent when idle. */
      readonly turnElapsedMs?: number;
      /** The last turn was aborted rather than finished. */
      readonly interrupted?: boolean;
      /** Context filled, 0–100. Absent until a turn has reported usage. */
      readonly contextPercent?: number;
      readonly contextWindow?: number;
      /** The repository git commands run in, relative to `cwd`; absent when it is `cwd`. */
      readonly repo?: string;
      /** Absent outside a git repository; this and the fields below describe `repo`. */
      readonly branch?: string;
      readonly dirtyCount?: number;
      readonly ahead?: number;
      readonly behind?: number;
      /** Changes whenever the working copy does, including dirty file content. */
      readonly repoRevision?: string;
      /** Absent when nothing is queued. */
      readonly queued?: QueuedView;
    }
  /** A frame the server could not attribute to any command. */
  | { readonly type: "error"; readonly message: string };

export type SessionSummaryView = {
  readonly sessionId: string;
  readonly cwd: string;
  readonly createdAt: number;
  /** End of the last completed turn (not file mtime); falls back to `createdAt`. Sort key. */
  readonly settledAt: number;
  /** The first user message, trimmed. */
  readonly title?: string;
  /** `title` is a user-set name, not the first message. */
  readonly named?: true;
  readonly archived?: true;
  readonly unread?: boolean;
  /** Absent when idle or not held open by this server. */
  readonly status?: SessionStatus;
  /** Running background subagents; absent when none or not held open by this server. */
  readonly jobs?: number;
};

export type ProjectView = {
  readonly cwd: string;
  /** Counted before the per-project cut. */
  readonly count: number;
  readonly pinned?: true;
  /** 0 first; only set when pinned. */
  readonly pinRank?: number;
  readonly expanded?: true;
  /** Overrides the directory's base name. */
  readonly label?: string;
};

export type SearchHitView = {
  readonly sessionId: string;
  readonly cwd: string;
  /** The session name, else the clamped first message. */
  readonly title?: string;
  /** Offsets into `title`. */
  readonly titleRanges: readonly SearchRange[];
  /** The first message, for rows where only the name matched. */
  readonly opening?: string;
  /** As in `SessionSummaryView`. */
  readonly settledAt: number;
  readonly archived?: true;
  readonly snippets: readonly SearchSnippet[];
  /** Matching messages, before the snippet cut. */
  readonly total: number;
};

export type SessionListing = {
  readonly sessions: readonly SessionSummaryView[];
  readonly projects: readonly ProjectView[];
};

export type SessionSearch = {
  readonly hits: readonly SearchHitView[];
  readonly dropped: readonly string[];
  /** Sessions searched. */
  readonly scanned: number;
};

export type ModelView = {
  readonly id: string;
  readonly label: string;
  /** The provider half of `id`. */
  readonly provider: string;
  readonly thinkingLevels?: readonly string[];
};

/** Answer to one `Command`, correlated by `id`. */
export type ResponseEvent = {
  readonly type: "response";
  readonly id: string;
  readonly success: boolean;
  readonly error?: string;
  /** For `pick_*`. */
  readonly items?: readonly PickerItem[];
  /** For `list_sessions`. */
  readonly sessions?: readonly SessionSummaryView[];
  /** For `list_sessions`. */
  readonly projects?: readonly ProjectView[];
  /** For `search_sessions`. */
  readonly hits?: readonly SearchHitView[];
  /** Query words no session held, for `search_sessions`. */
  readonly dropped?: readonly string[];
  /** For `search_sessions`. */
  readonly scanned?: number;
  /** For `list_models`. */
  readonly models?: readonly ModelView[];
  /** The current model's levels, for `list_models`. */
  readonly thinkingLevels?: readonly string[];
  /** For `list_extensions`. */
  readonly extensions?: readonly ExtensionEntry[];
  /** For `list_dirs`. */
  readonly directory?: DirectoryListing;
  /** For `list_branches`. */
  readonly branches?: readonly GitBranch[];
  /** For `commit`. */
  readonly commit?: Pick<Extract<CommitResult, { readonly ok: true }>, "sha">;
  /** For `list_changes`. */
  readonly changes?: ChangeList;
  /** For `file_diff`. */
  readonly fileDiff?: FileDiff;
  /** For `read_lines`. */
  readonly fileLines?: FileLines;
  /** For `list_repos`: paths relative to the cwd, sorted. */
  readonly repos?: readonly string[];
  /** For `list_files`. */
  readonly files?: FileList;
  /** For `read_file`. */
  readonly file?: FileContent;
  /** For `cancel` and `dequeue`: queued messages handed back to the client. */
  readonly restored?: readonly string[];
  /** For `user_message`: an extension command ran, so no turn started. */
  readonly dispatched?: boolean;
};

export type ServerEvent = DurableEvent | EphemeralEvent | ResponseEvent;

export type StreamEvent = DurableEvent | EphemeralEvent;

export type ServerEventType = ServerEvent["type"];

export function isDurableEvent(event: ServerEvent): event is DurableEvent {
  return "seq" in event;
}

/** Whether the event belongs to the attached session, so a client mid-attach should drop it. */
export function isAttachScoped(event: ServerEvent): boolean {
  switch (event.type) {
    case "attached":
    case "replay":
    case "message":
    case "message_start":
    case "message_retire":
    case "text_delta":
    case "thinking_delta":
    case "tool_call":
    case "tool_update":
    case "tool_end":
    case "tool_result":
    case "notice":
    case "subagent_result":
    case "subagent_notice":
    case "subagent_events":
    case "turn_end":
    case "jobs":
    case "session_state":
    case "ui_notice":
    case "ui_request":
    case "ui_request_done":
    // Only sent down the attached session's stream.
    case "picker_invalidate":
      return true;
    case "session_activity":
    case "session_read":
    case "session_meta":
    case "project_meta":
    case "pins_changed":
    case "sessions_changed":
    case "extensions_changed":
    case "update_state":
    case "error":
    case "response":
      return false;
    default:
      event satisfies never;
      return false;
  }
}
