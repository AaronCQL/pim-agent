import type { PickerItem } from "#core/picker/PickerItem";
import type { UpdateSkip } from "#core/shared/Updater";
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
      /** When pi appended the entry, in epoch ms. */
      readonly timestamp: number;
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
 * What the `reload` the operator asked for is doing.
 *
 * A `phase` rather than four event types because a client draws one thing
 * with it — the state of the one run this server can have in flight — and a
 * receiver that has to know which of four names to listen for is holding the
 * union together itself.
 */
export type UpdateStateEvent =
  /** A step of the run started, named as the updater names it. */
  | {
      readonly type: "update_state";
      readonly phase: "step";
      readonly label: string;
    }
  /**
   * The update is done and this process is on its way out; the supervisor
   * brings the next one up in its place. Carries where the version moved, so
   * a client that reconnects can say what it came back to, and what the
   * update declined to do — a skip is the difference between "done" and
   * "done what it could", and the operator is the only one who can act on it.
   */
  | {
      readonly type: "update_state";
      readonly phase: "restarting";
      readonly from: string;
      readonly to: string;
      readonly skipped: readonly UpdateSkip[];
    }
  /**
   * The update is done and nothing is going to restart this process: it was
   * started by hand rather than by a supervisor, so exiting would end it
   * instead of replacing it. The new code is on disk and the old code is
   * still the code answering — only the operator can close that gap.
   */
  | {
      readonly type: "update_state";
      readonly phase: "stranded";
      readonly from: string;
      readonly to: string;
      readonly skipped: readonly UpdateSkip[];
    }
  /**
   * A step failed and the run stopped there. Nothing restarts and nothing is
   * lost: this server goes on serving the code it was already running, which
   * is the version known to work.
   */
  | {
      readonly type: "update_state";
      readonly phase: "failed";
      readonly error: string;
    };

/**
 * The live preview of the turn in flight, and the session state around it.
 * Deliberately **unsequenced**: none of it is persisted line by line, so none
 * of it can be replayed by ordinal. A reconnecting client is instead handed
 * the whole in-flight turn coalesced — one `message_start` per assistant
 * message, each followed by a single `thinking_delta`/`text_delta` carrying
 * everything streamed into it so far and the calls it made — and then the
 * durable events supersede it once pi appends the finished messages.
 *
 * A turn is **many** assistant messages, not one: pi writes an entry per model
 * call, and it writes them long after they streamed. So the bucket is a list
 * in arrival order, keyed by `messageId`, and `message_retire` names the one
 * entry a durable message has just superseded — dropping the bucket wholesale
 * is what loses the prose of every step but the last. Live `tool_call` events
 * re-appear inside a durable message's `toolCalls`; dedupe on `callId`.
 */
export type EphemeralEvent =
  | {
      readonly type: "attached";
      readonly protocolVersion: ProtocolVersion;
      readonly sessionId: string;
      readonly cwd: string;
      /** Highest durable `seq` at attach time; replay follows immediately. */
      readonly head: number;
      /**
       * The pim and pi this server is running. Sent on the handshake because
       * a process cannot change the code it is executing: these move when the
       * server is replaced, so the frame that says a new server is here is
       * the only place they can change.
       */
      readonly pimVersion: string;
      readonly piVersion: string;
    }
  /**
   * Events handed over as one frame instead of one frame per event: a resume,
   * and every read of the log the server makes while a turn runs. A client
   * applies these in order and is otherwise free to treat each exactly as it
   * would have arrived on its own — the envelope carries no meaning beyond
   * "these landed together", which is what lets a client paint a whole
   * conversation in a single pass rather than once per line of it, and what
   * keeps a durable message and the `message_retire` that supersedes its live
   * copy from being two paints with the same step drawn twice in between.
   */
  | { readonly type: "replay"; readonly events: readonly StreamEvent[] }
  | {
      readonly type: "message_start";
      readonly role: "assistant";
      readonly messageId: string;
    }
  /**
   * The live message with this id is now a line in the log, and the durable
   * `message` that says so was sent immediately before it. Named rather than
   * counted because the two are not in step: a step's calls run *after* pi
   * closes its message, so the bucket can grow between a message ending and
   * its entry being written, and "the oldest live message" is by then some
   * other step's.
   */
  | { readonly type: "message_retire"; readonly messageId: string }
  | {
      readonly type: "text_delta";
      readonly messageId: string;
      readonly delta: string;
    }
  /** Reasoning as it streams; the durable message carries the whole of it. */
  | {
      readonly type: "thinking_delta";
      readonly messageId: string;
      readonly delta: string;
    }
  | {
      readonly type: "tool_call";
      readonly callId: string;
      readonly name: string;
      /** The live message that asked for it, which is what orders the row. */
      readonly messageId: string;
      readonly view: ToolView;
    }
  | {
      readonly type: "tool_update";
      readonly callId: string;
      readonly view: ToolView;
    }
  /**
   * The call finished. Its result is durable, but only once pi appends it —
   * which can be a whole turn later — so this carries the settled view in the
   * meantime and the `tool_result` for the same `callId` supersedes it.
   */
  | {
      readonly type: "tool_end";
      readonly callId: string;
      readonly view: ToolView;
      readonly isError: boolean;
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
  /**
   * A session's agent started or stopped working. Sent to every client, not
   * just the ones attached to that session: a session list has a row per
   * session and only this says that a row nobody is watching is working.
   *
   * Only the sessions this server holds open can be reported on. One a
   * terminal is driving is another process with nothing but the log file
   * between them, so it is never named here and reads as idle.
   */
  | {
      readonly type: "session_activity";
      readonly sessionId: string;
      readonly status: SessionStatus;
    }
  /**
   * Some client has read a session, so its unread mark is gone — everywhere,
   * because the cursor behind it is one per session rather than one per
   * client. Sent to every connection for the same reason `session_activity`
   * is: it is news precisely to the ones not attached to that session.
   */
  | { readonly type: "session_read"; readonly sessionId: string }
  /**
   * Sent to every connection, for the sharper form of the same reason: the
   * restart it ends in drops every socket on this server, so a client that
   * did not ask is the one most in need of being told why it is about to
   * lose the one it has.
   */
  | UpdateStateEvent
  | {
      readonly type: "session_state";
      readonly cwd: string;
      readonly model: string;
      /**
       * The same model's display name, as the catalogue spells it. Sent
       * alongside the id so a client can name the current model without
       * fetching the whole catalogue first; absent before one resolves.
       */
      readonly modelLabel?: string;
      readonly thinking: string;
      readonly cost: number;
      readonly status: SessionStatus;
      readonly tps?: number;
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
  /**
   * When this session's agent last stopped: the end of its last completed
   * turn, and the sort key of the catalogue. Deliberately *not* the file's
   * modified time — that moves when the user says something, and a row must
   * not reorder or reset its age because a message was typed into it. It
   * stands still for the whole of a turn and steps once when that turn ends,
   * so a list only ever re-sorts on a reply.
   *
   * Falls back to `createdAt` for a session whose agent has never answered.
   */
  readonly settledAt: number;
  /** The session's first user message, trimmed; absent when it has none. */
  readonly title?: string;
  /**
   * This session has answered since anything last read it; absent means it
   * has not. Decided here rather than from a cursor sent alongside, because
   * the comparison is against the end of the last completed turn — which is
   * `settledAt` only when the session has ever answered, and this is the
   * side that can tell that from a session falling back to `createdAt`.
   */
  readonly unread?: boolean;
  /**
   * What this session's agent is doing, for a list drawn without attaching
   * to every row. Absent when it is doing nothing — which is also the answer
   * for a session this server does not hold open, since only the process
   * running the agent can know.
   */
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
  /**
   * For `cancel` and `dequeue`: the messages pi was still holding for the
   * turn. They were never said, so the client that asked owns them from here
   * — the TUI puts them back in its editor, and so does the web.
   */
  readonly restored?: readonly string[];
};

export type ServerEvent = DurableEvent | EphemeralEvent | ResponseEvent;

/** Anything a session emits: everything on the wire but an answer to a command. */
export type StreamEvent = DurableEvent | EphemeralEvent;

export type ServerEventType = ServerEvent["type"];

export function isDurableEvent(event: ServerEvent): event is DurableEvent {
  return "seq" in event;
}
