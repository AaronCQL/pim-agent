import type { DirectoryListing } from "#core/shared/Directories";
import type { CommitResult, GitBranch } from "#core/shared/Git";
import type { PickerItem } from "#core/picker/PickerItem";
import type { SearchRange, SearchSnippet } from "#core/session/SearchIndex";
import type { LeaseFrontend } from "#core/session/SessionLease";
import type { UpdateSkip } from "#core/shared/Updater";
import type { NoticeSeverity, ToolView } from "#core/view/ViewBlock";
import type { ChangeList, FileDiff, FileLines } from "./Diff";

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
      readonly sessionId: string;
      readonly cwd: string;
      /** Highest durable `seq` at attach time; replay follows immediately. */
      readonly head: number;
      /** The server's build; a client built from another one is stale and should reload. */
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
  /** Something an extension said, in Markdown; shown and then forgotten, never written to the session. */
  | {
      readonly type: "ui_notice";
      readonly id: string;
      readonly severity: NoticeSeverity;
      readonly text: string;
      /** The command being dispatched when it was said, like `/login`; absent means nobody asked for it. */
      readonly command?: string;
    }
  /** An extension is waiting on a human; the first `ui_response` wins and the rest are refused. */
  | {
      readonly type: "ui_request";
      readonly requestId: string;
      readonly method: "select" | "confirm" | "input";
      readonly title: string;
      readonly message?: string;
      readonly options?: readonly string[];
      readonly placeholder?: string;
      /** The command that asked, like `/login`; absent where an extension asked unprompted. */
      readonly command?: string;
    }
  /** The request is settled, by whoever answered it or by the server answering for them; drop its control. */
  | { readonly type: "ui_request_done"; readonly requestId: string }
  /** Sent to every connection, not just those attached; only sessions this server holds open are reported. */
  | {
      readonly type: "session_activity";
      readonly sessionId: string;
      readonly status: SessionStatus;
    }
  /** Sent to every connection; the read cursor is one per session, not one per client. */
  | { readonly type: "session_read"; readonly sessionId: string }
  /** Sent to every connection: one session's name or overrides changed, so a listing a client holds can be patched in place. */
  | {
      readonly type: "session_meta";
      readonly sessionId: string;
      /** The session's own name, `null` once it is cleared. */
      readonly name?: string | null;
      readonly archived?: boolean;
      readonly unread?: boolean;
    }
  /**
   * Sent to every connection; keyed by absolute working directory, not by
   * session. A patch like `session_meta`: only what changed is said, so a
   * fold carries no claim about the pin beside it.
   */
  | {
      readonly type: "project_meta";
      readonly cwd: string;
      readonly pinned?: boolean;
      readonly expanded?: boolean;
      /** What the project is called in a listing, `null` once it is cleared. */
      readonly label?: string | null;
    }
  /** Sent to every connection: the pinned projects, in the order they are shown. */
  | { readonly type: "pins_changed"; readonly order: readonly string[] }
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
      /** Changes whenever the working copy does, content of a dirty file included. */
      readonly repoRevision?: string;
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
  /** True when `title` is a name somebody wrote, rather than the first message. */
  readonly named?: true;
  readonly archived?: true;
  /** Has answered since anything last read it; absent means it has not. */
  readonly unread?: boolean;
  /** Absent when idle, and for a session this server does not hold open. */
  readonly status?: SessionStatus;
};

/** One working directory the catalogue holds sessions for, counted before any per-project cut. */
export type ProjectView = {
  readonly cwd: string;
  /** Every session in it the listing's scope allows, including the ones the cut dropped. */
  readonly count: number;
  readonly pinned?: true;
  /** Where it sorts among the pinned, 0 first; absent unless it is pinned. */
  readonly pinRank?: number;
  /** The sidebar group stands unfolded; absent is folded. */
  readonly expanded?: true;
  /** What to call it instead of its base name; absent when it goes by the directory. */
  readonly label?: string;
};

/**
 * One session a search matched. Deliberately not a `SessionSummaryView`: what
 * a ranked list needs is why the row matched, and `unread` is the sidebar's
 * triage while `status` resolves itself the moment the session opens.
 */
export type SearchHitView = {
  readonly sessionId: string;
  readonly cwd: string;
  /** Its name if it has one, else the clamped opening message; the digest's, so it agrees with the sidebar's. */
  readonly title?: string;
  /** Offsets into the clamped `title`, empty when the title did not match. */
  readonly titleRanges: readonly SearchRange[];
  /** The session's opening ask, for a row whose name is all that matched and so has no snippet to show. */
  readonly opening?: string;
  /** End of the last completed turn and the row's clock, never the file mtime; falls back to when the session started, as the sidebar's does. */
  readonly settledAt: number;
  /** Searched and found anyway: the badge that makes "archived are in scope" honest. */
  readonly archived?: true;
  /** What matched, in the words it was said in, each with its own ranges. */
  readonly snippets: readonly SearchSnippet[];
  /** Matching messages in this session, before the snippet cut. */
  readonly total: number;
};

/** One answer to `list_sessions`: the page of rows, and every directory that had one, counted whole. */
export type SessionListing = {
  readonly sessions: readonly SessionSummaryView[];
  /** Counted before the per-project cut, so a group can say what a page of it leaves out. */
  readonly projects: readonly ProjectView[];
};

/** One answer to `search_sessions`: the ranked rows, the words no session held, and the scope it read. */
export type SessionSearch = {
  readonly hits: readonly SearchHitView[];
  readonly dropped: readonly string[];
  /** Sessions searched, whole: what the empty state and the result footer say out loud. */
  readonly scanned: number;
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
  /** The directories those sessions came from, for `list_sessions`. */
  readonly projects?: readonly ProjectView[];
  /** The ranked sessions, for `search_sessions`. */
  readonly hits?: readonly SearchHitView[];
  /** Query words no session held, dropped so the rest could match, for `search_sessions`. */
  readonly dropped?: readonly string[];
  /** Sessions the query actually searched, for `search_sessions`. */
  readonly scanned?: number;
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
  /** For `user_message`: it named an extension command, so no turn started and no entry was written. */
  readonly dispatched?: boolean;
};

export type ServerEvent = DurableEvent | EphemeralEvent | ResponseEvent;

/** Anything a session emits: everything on the wire but an answer to a command. */
export type StreamEvent = DurableEvent | EphemeralEvent;

export type ServerEventType = ServerEvent["type"];

export function isDurableEvent(event: ServerEvent): event is DurableEvent {
  return "seq" in event;
}

/**
 * Whether the frame speaks for the one session a connection is attached to,
 * and so says nothing to a client whose attach is still in flight. The rest
 * name their own subject — another session, a directory, or nothing at all —
 * and gating those on the attach window drops a broadcast every time a client
 * switches session.
 *
 * Exhaustive by construction: a new event is a type error here until it is
 * classified, which is the only reason this lives beside the wire types
 * rather than in the client that gates on it.
 */
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
    case "subagent_events":
    case "turn_end":
    case "session_state":
    case "ui_notice":
    case "ui_request":
    case "ui_request_done":
    // Names a cwd, but only ever reaches a client down the session stream it
    // is attached to, so the old session's is the only one that can arrive
    // mid-attach — and re-querying for it would warm the wrong cache.
    case "picker_invalidate":
      return true;
    case "session_activity":
    case "session_read":
    case "session_meta":
    case "project_meta":
    case "pins_changed":
    case "sessions_changed":
    case "update_state":
    // Sent for a frame the server could not read at all, which is likeliest
    // before an attach has settled: gating it swallows the diagnostic.
    case "error":
    case "response":
      return false;
    default:
      event satisfies never;
      return false;
  }
}
