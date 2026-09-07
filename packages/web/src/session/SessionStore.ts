import { createStore, type Store, type StoreSetter } from "solid-js";

import type { PickerItem } from "#core/picker/PickerItem";
import { RemoteFilePickerSuggestionEngine } from "#core/picker/RemoteFilePickerSuggestionEngine";
import type { ToolView } from "#core/view/ViewBlock";
import type { AttachmentRef, CommandDraft } from "#protocol/Command";
import type {
  AttachmentView,
  DurableEvent,
  EphemeralEvent,
  ModelView,
  ServerEvent,
  SessionStatus,
  SessionSummaryView,
  StreamEvent,
  TurnStats,
} from "#protocol/ServerEvent";
import { isDurableEvent } from "#protocol/ServerEvent";
import {
  WsClient,
  type AttachTarget,
  type ConnectionStatus,
} from "../ws/WsClient";
import { Reload } from "./Reload";

export type LiveTool = {
  readonly callId: string;
  readonly name: string;
  readonly view: ToolView;
  readonly isError: boolean;
  /** The call is on the wire but nothing has settled its result yet. */
  readonly isPartial: boolean;
};

/**
 * One assistant message of the turn in flight. There is a list of them, not
 * one: a turn is a model call per step, and pi appends the entry for a step
 * long after it streamed — usually only when the whole turn settles — so a
 * bucket that held a single message would drop the prose of every step but
 * the last on the floor.
 */
export type LiveMessage = {
  readonly messageId: string;
  text: string;
  thinking: string;
  tools: LiveTool[];
  /**
   * The durable copy of this message has landed, so its prose is gone from
   * here and what is left is a shell holding the calls it made. Those outlive
   * it: pi writes a step down before it writes the results of the calls that
   * step asked for, and the durable message restates each call without one,
   * so until the results are written this is the only settled view of them
   * there is — and the only place an update to one still running can land.
   */
  retired: boolean;
};

/**
 * The one subagent this browser is reading: the child's own log as far as it
 * has been sent, and its turn in flight. The same two halves the session has,
 * because a child's transcript is a transcript — and separate from them,
 * because nothing a child said belongs in the conversation that spawned it.
 */
export type SubagentTranscript = {
  readonly callId: string;
  events: DurableEvent[];
  live: LiveMessage[];
};

/** What the composer's two chips choose from; one query answers both. */
export type ModelCatalogue = {
  readonly models: readonly ModelView[];
  readonly thinkingLevels: readonly string[];
};

/**
 * A file the server is holding for the next message. `id` is what a prompt
 * refers to it by; `url` is where the bytes can be looked at, already
 * resolved against the server this store is talking to.
 */
export type UploadedAttachment = {
  readonly id: string;
  readonly url: string;
  readonly isImage: boolean;
  /** The client's own name for the bytes, which is the one worth showing. */
  readonly name: string;
};

/**
 * A message this client has said and the server has not echoed back yet. Not
 * a `DurableEvent` pretending to be one: it has no ordinal, its stamp is a
 * guess, and — unlike anything the log can hold — it may still be sitting in
 * pi's queue rather than in the conversation, which is what `queued` names.
 */
export type PendingMessage = {
  readonly id: string;
  readonly text: string;
  /** The files sent with it, so the row is not a caption with nothing above it. */
  readonly attachments?: readonly AttachmentView[];
  /**
   * When it was said, which is the closest thing to a stamp there is until
   * the durable event that supersedes it arrives with pi's own.
   */
  readonly timestamp: number;
  /** Said into a running turn, so pi holds it; absent when it began one. */
  readonly queued?: boolean;
};

/** The same message, as the store holds it: grown in place by a second send. */
type OptimisticMessage = {
  id: string;
  text: string;
  attachments?: readonly AttachmentView[];
  timestamp: number;
  queued?: boolean;
};

/**
 * A session this client made and the server has not written a line of yet, so
 * it exists in the gateway's memory and nowhere else: the sessions directory
 * cannot list it, which is why the sidebar is handed it separately.
 */
export type Unwritten = {
  readonly sessionId: string;
  readonly cwd: string;
  /**
   * A message has gone out, so it is a conversation now and only the listing
   * is behind. The row stays until the directory can answer for it, but a new
   * chat asked for from here is a new session rather than a return to this
   * one.
   */
  readonly sent: boolean;
};

/**
 * The unwritten session as the sidebar paints it: one row the listing has no
 * answer for. Untitled here like every other row, because a row is named by
 * `localTitle` whichever source drew it.
 */
export type UnwrittenSummary = {
  readonly sessionId: string;
  readonly cwd: string;
};

/**
 * Store state is a draft the setter mutates, so its fields are deliberately
 * mutable; consumers only ever see it through the readonly `Store<T>` view.
 */
export type SessionState = {
  connection: ConnectionStatus;
  sessionId: string;
  cwd: string;
  /** The id `set_model` takes; `modelLabel` is what a reader is shown. */
  model: string;
  modelLabel: string;
  thinking: string;
  cost: number;
  agent: SessionStatus;
  tps: number | undefined;
  contextPercent: number | undefined;
  contextWindow: number | undefined;
  branch: string | undefined;
  /** Paths git reports as changed; zero is a clean tree. */
  dirtyCount: number;
  ahead: number;
  behind: number;
  durable: DurableEvent[];
  live: LiveMessage[];
  optimistic: OptimisticMessage[];
  /**
   * What every session this browser has heard of is doing, attached or not.
   * Written from three places that never disagree: the listing, the live
   * `session_activity` frames, and the attached session's own state.
   */
  activity: Record<string, SessionStatus>;
  /**
   * Attached to a session whose log has not arrived yet. Only ever true
   * between an `attached` naming a new session and the frame that replays it,
   * so the transcript is painted once, whole, rather than assembled on screen.
   */
  loading: boolean;
  stats: TurnStats | undefined;
  error: string | undefined;
  /**
   * Which sessions have answered since anything last read them, as the
   * server says it. Written from the listing and cleared by the frame that
   * says some client has opened one — this browser or another, since the
   * cursor behind it is one per session and not one per client.
   */
  unread: Record<string, boolean>;
  /**
   * The composer's unsent message, per session. The box belongs to the
   * session it is typed into rather than to the page, so switching swaps
   * what is in it and leaves the other message where it was written.
   */
  drafts: Record<string, string>;
  /**
   * The files uploaded for a message not yet sent, per session, for the same
   * reason and by the same rule as `drafts`. Kept in memory alone: the
   * server holds the bytes against ids it forgets when it restarts, so an id
   * that outlived a reload would name nothing.
   */
  attachments: Record<string, readonly UploadedAttachment[]>;
  /**
   * The message a session was opened with, per session, kept only until the
   * listing can say it too. A session is named by its opening message, and
   * between sending one and pi's log being scanned for it there is a window
   * where nothing else in this browser knows what it was: the transcript
   * answers for the attached session alone, so switching away mid-turn would
   * otherwise drop the row back to an id it already had a name for.
   *
   * In memory rather than in `localStorage`: it is worth a keystroke to keep
   * a name from flickering, not a synchronous disk write, and a reload is
   * slow enough that the listing has the answer by the time it lands.
   */
  openings: Record<string, string>;
  /** The one session with no file yet, if this browser is holding one. */
  unwritten: Unwritten | undefined;
  /**
   * The subagent being read over the conversation, if one is. At most one,
   * ever: a subagent cannot spawn a subagent, so nothing can be read on top
   * of this.
   */
  subagent: SubagentTranscript | undefined;
};

export type SessionStoreOptions = {
  readonly url: string;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly backoffMs?: (attempt: number) => number;
  /** Picker debounce; 0 in tests. */
  readonly pickerDebounceMs?: number;
  readonly reloadPage?: () => void;
};

const FILE_PICKER_LIMIT = 50;
const COMMAND_PICKER_LIMIT = 20;

/**
 * Where the unsent messages and the id of the unwritten session live across a
 * reload. Local to this browser deliberately, unlike the read cursor: an
 * unsent message is not part of the conversation, and no other client has any
 * business seeing it.
 */
const DRAFTS_KEY = "pim.drafts";
const UNWRITTEN_KEY = "pim.unwritten";

/**
 * Everything the browser knows about one session, and the only place an
 * intent turns into a command.
 *
 * The client is business-logic-free but not dumb: what lives here is draft
 * state, the optimistic echo, and the trailing in-flight bucket — presentation
 * concerns the server has no reason to model. It never builds a prompt, never
 * ranks a picker, and never decides whether a tool may run.
 */
export class SessionStore {
  public readonly client: WsClient;
  public readonly update: Reload;
  /** The `@` picker, answered one query at a time by the server. */
  public readonly files: RemoteFilePickerSuggestionEngine;
  public readonly state: Store<SessionState>;
  private readonly setState: StoreSetter<SessionState>;
  private optimisticId = 0;
  /** The catalogue is a property of the server, so one query per connection. */
  private catalogue: Promise<ModelCatalogue> | undefined;
  /**
   * The unsent messages, synchronously. The store copy is the same strings,
   * but a keystroke writes it before anything reads it back, so the
   * persisted value is taken from here.
   */
  private readonly drafts: Record<string, string>;
  /**
   * Pending `localStorage` writes, one per key. A draft moves far faster
   * than a reload can read it — once per keystroke — and `localStorage` is
   * synchronous disk, so the writes are coalesced onto the next microtask:
   * what a reload needs is where a value ended up, not each place it passed
   * through.
   */
  private readonly writes = new Map<string, () => string | undefined>();
  /**
   * The unsent message waiting for a session to belong to, held while an
   * attach for a *new* chat is in flight. Id and cwd are the server's to
   * assign, so the draft is recorded where they arrive — the `attached`
   * frame — rather than read back out of a store that settles its writes on
   * its own schedule.
   */
  private claimed: string | undefined;

  public constructor(options: SessionStoreOptions) {
    this.update = new Reload(options.url, options.reloadPage);
    const drafts = readDrafts();
    // An unwritten session has no file, so nothing but this browser remembers
    // it; resuming it is the whole reason the id was written down.
    const unwritten = readUnwritten();
    const sessionId =
      options.sessionId ??
      this.update.target?.sessionId ??
      unwritten?.sessionId;
    const cwd = options.cwd ?? this.update.target?.cwd ?? unwritten?.cwd;
    const [state, setState] = createStore<SessionState>({
      connection: "closed",
      sessionId: "",
      cwd: cwd ?? "",
      model: "",
      modelLabel: "",
      thinking: "",
      cost: 0,
      agent: "idle",
      tps: undefined,
      contextPercent: undefined,
      contextWindow: undefined,
      branch: undefined,
      dirtyCount: 0,
      ahead: 0,
      behind: 0,
      durable: [],
      live: [],
      optimistic: [],
      activity: {},
      loading: false,
      stats: undefined,
      error: undefined,
      unread: {},
      drafts: { ...drafts },
      attachments: {},
      openings: {},
      unwritten,
      subagent: undefined,
    });
    this.drafts = drafts;
    // Nothing to attach to means the server is about to make a session, and
    // a session made for this browser with nothing in it is a draft — the
    // first chat of a fresh tab belongs in the sidebar like any other.
    this.claimed = sessionId === undefined ? "" : undefined;
    this.state = state;
    this.setState = setState;
    this.client = new WsClient({
      url: options.url,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(options.backoffMs === undefined
        ? {}
        : { backoffMs: options.backoffMs }),
      onEvent: (event) => {
        this.ingest(event);
      },
      onStatus: (connection) => {
        this.update.connection(connection);
        this.setState((draft) => {
          draft.connection = connection;
        });
      },
    });
    this.files = new RemoteFilePickerSuggestionEngine(
      (query, limit) => this.pickFiles(query, limit ?? FILE_PICKER_LIMIT),
      options.pickerDebounceMs
    );
  }

  public async connect(): Promise<void> {
    const response = await this.client.connect();
    if (response.success) {
      return;
    }
    const unwritten = this.state.unwritten;
    // The refused session is the unwritten one this browser was holding: it
    // only ever existed in a gateway that has since restarted, and a session
    // with no file cannot be resumed from one. Anything else refused is a
    // refusal the caller asked for and has to hear about.
    if (!unwritten || this.client.sessionId !== unwritten.sessionId) {
      throw new Error(response.error ?? "attach was refused");
    }
    await this.restart(unwritten);
  }

  public dispose(): void {
    this.client.close();
    this.update.dispose();
  }

  public async reload(force = false): Promise<void> {
    if (
      !this.update.begin({
        sessionId: this.state.sessionId,
        cwd: this.state.cwd,
      })
    ) {
      return;
    }
    try {
      const response = await this.client.send({
        type: "reload",
        ...(force ? { force } : {}),
      });
      if (!response.success) {
        this.update.rejected(
          response.error ?? "The server refused the restart."
        );
      }
    } catch (error) {
      this.update.rejected((error as Error).message);
    }
  }

  /**
   * This client's own unacknowledged messages: what was typed and not yet
   * echoed back. The live turn is separate — `state.live` — because a
   * streaming message is not a durable one with a flag on it.
   */
  public trailing(): readonly PendingMessage[] {
    return this.state.optimistic;
  }

  /**
   * How much live content there is, as one number: a cheap dependency for an
   * effect that only needs to know that the turn grew.
   */
  public liveSize(): number {
    let size = 0;
    for (const message of this.state.live) {
      size += message.text.length + message.thinking.length;
      size += message.tools.length;
    }
    return size;
  }

  public isBusy(): boolean {
    return this.state.agent !== "idle";
  }

  /**
   * Whether that session's agent is working, for any session and not just the
   * one being read. A session the server does not hold open reads as idle,
   * which is also the honest answer for one a terminal is driving: those two
   * processes share a log file and nothing else.
   */
  public isRunning(sessionId: string): boolean {
    return (this.state.activity[sessionId] ?? "idle") !== "idle";
  }

  /** Every session heard to be working, sorted; a stable dependency. */
  public runningIds(): readonly string[] {
    return Object.keys(this.state.activity)
      .filter((sessionId) => this.isRunning(sessionId))
      .sort();
  }

  /**
   * Says the message. Into a running turn it steers, and it joins whatever
   * that turn is already holding rather than queueing behind it: the server
   * merges on its side too, so one waiting message is one row here and one
   * user message there.
   */
  public async prompt(text: string): Promise<void> {
    const trimmed = text.trim();
    const sessionId = this.state.sessionId;
    const attachments = this.attachmentsOf(sessionId);
    if (trimmed === "" && attachments.length === 0) {
      return;
    }
    const carried: readonly AttachmentView[] = attachments.map(
      ({ name, url, isImage }) => ({ name, url, isImage })
    );
    const busy = this.isBusy();
    // Decided inside the write rather than from `state`, which settles on its
    // own schedule: two messages typed into the same tick must still find
    // each other, and only the draft is guaranteed to have the first one.
    let id = "";
    let previous: string | undefined;
    this.setState((draft) => {
      // Decided in here for the same reason as `id`: what opens a session is
      // a question about the message *before* this one, and only the write
      // sees them in order.
      const opens =
        openingMessage(draft.durable, draft.optimistic) === undefined;
      const growing = busy
        ? draft.optimistic.find((pending) => pending.queued)
        : undefined;
      if (growing) {
        // The same join the server makes of the same two messages, so the
        // durable echo that lands later reads as what was on screen.
        id = growing.id;
        previous = growing.text;
        growing.text = `${growing.text}\n\n${trimmed}`;
        growing.attachments = [...(growing.attachments ?? []), ...carried];
      } else {
        id = `optimistic:${++this.optimisticId}`;
        draft.optimistic.push({
          id,
          text: trimmed,
          ...(carried.length === 0 ? {} : { attachments: carried }),
          // Nothing has been written yet, so the only honest stamp is the
          // moment it was said; the durable echo carries pi's own.
          timestamp: Date.now(),
          ...(busy ? { queued: true } : {}),
        });
      }
      if (opens) {
        draft.openings[draft.sessionId] = trimmed;
      }
      draft.error = undefined;
    });
    this.spendDraft();
    const refs: readonly AttachmentRef[] = attachments.map(({ id: ref }) => ({
      id: ref,
    }));
    try {
      const response = await this.client.send({
        type: "user_message",
        sessionId,
        text: trimmed,
        ...(refs.length === 0 ? {} : { attachments: refs }),
      });
      if (!response.success) {
        throw new Error(response.error ?? "the server refused the message");
      }
    } catch (err) {
      // The refused message leaves the row it was added to; a row it *grew*
      // still stands for what pi is holding, so it shrinks back instead.
      this.rollback(id, previous);
      this.setState((draft) => {
        draft.error = (err as Error).message;
      });
    }
  }

  /**
   * Stop the turn, and answer with what died queued behind it — never said,
   * so its row comes off the transcript here and the composer puts the text
   * back in the box the way the TUI puts it back in its editor.
   */
  public cancel(): Promise<string> {
    return this.reclaim({ type: "cancel", sessionId: this.state.sessionId });
  }

  /**
   * Take the waiting message back to edit it, leaving the turn running. The
   * whole of it: it is one message on both sides of the wire, however many
   * times the reader added to it.
   */
  public dequeue(): Promise<string> {
    return this.reclaim({ type: "dequeue", sessionId: this.state.sessionId });
  }

  /**
   * The half `cancel` and `dequeue` share: whatever pi hands back was never
   * said, so its row goes and the text becomes the caller's.
   */
  private async reclaim(draft: CommandDraft): Promise<string> {
    const response = await this.client.send(draft).catch(() => undefined);
    const restored = response?.restored ?? [];
    if (restored.length > 0) {
      this.dropQueued();
    }
    return restored.join("\n\n");
  }

  /**
   * Read one subagent's transcript, live if it is still running. Read-only in
   * the strong sense: it reaches no agent, and the child's events arrive
   * enveloped, so nothing drawn from them can land in the conversation.
   */
  public async watch(callId: string): Promise<void> {
    this.setState((draft) => {
      draft.subagent = { callId, events: [], live: [] };
    });
    await this.sendWatch(callId, 0);
  }

  /**
   * Let the child go. The server drops a watch on socket close and on an
   * attach elsewhere, but a modal closed on a live connection is neither, and
   * a watch left behind one is a projection growing for nobody.
   */
  public unwatch(): void {
    const watched = this.state.subagent;
    if (!watched) {
      return;
    }
    this.setState((draft) => {
      draft.subagent = undefined;
    });
    // Whether or not the server still holds one: closing a modal over a
    // connection that has since dropped is not a failure anyone need hear.
    void this.client
      .send({ type: "unwatch_subagent", callId: watched.callId })
      .catch(() => undefined);
  }

  private async sendWatch(callId: string, fromSeq: number): Promise<void> {
    try {
      const response = await this.client.send({
        type: "watch_subagent",
        sessionId: this.state.sessionId,
        callId,
        fromSeq,
      });
      if (!response.success) {
        throw new Error(response.error ?? "the server refused the watch");
      }
    } catch (error) {
      // A child that cannot be read is not a modal onto a blank sheet: the
      // reader is put back where they were and told why, as for any refusal.
      this.setState((draft) => {
        if (draft.subagent?.callId === callId) {
          draft.subagent = undefined;
        }
        draft.error = (error as Error).message;
      });
    }
  }

  public async pickFiles(
    query: string,
    limit = FILE_PICKER_LIMIT
  ): Promise<readonly PickerItem[]> {
    const response = await this.client
      .send({
        type: "pick_files",
        sessionId: this.state.sessionId,
        query,
        limit,
      })
      .catch(() => undefined);
    return response?.items ?? [];
  }

  public async pickCommands(
    query: string,
    limit = COMMAND_PICKER_LIMIT
  ): Promise<readonly PickerItem[]> {
    const response = await this.client
      .send({
        type: "pick_commands",
        sessionId: this.state.sessionId,
        query,
        limit,
      })
      .catch(() => undefined);
    return response?.items ?? [];
  }

  public async listSessions(
    cwd?: string
  ): Promise<readonly SessionSummaryView[]> {
    const response = await this.client
      .send({ type: "list_sessions", ...(cwd === undefined ? {} : { cwd }) })
      .catch(() => undefined);
    const sessions = response?.sessions ?? [];
    // The listing is the one source that answers for a session no frame has
    // mentioned yet — a turn this browser was not connected for, or one
    // started before it loaded.
    this.setState((draft) => {
      for (const session of sessions) {
        draft.activity[session.sessionId] = session.status ?? "idle";
        draft.unread[session.sessionId] = session.unread ?? false;
        // The listing can name it now, so the copy held for the gap has
        // nothing left to cover: dropping it here is what keeps this from
        // growing one entry per session this browser has ever written to.
        if (session.title !== undefined) {
          delete draft.openings[session.sessionId];
        }
      }
    });
    // Pi has written the session's first line, so the directory answers for
    // it now and the synthetic row would be a second copy of a real one.
    const unwritten = this.state.unwritten;
    if (
      unwritten &&
      sessions.some(({ sessionId }) => sessionId === unwritten.sessionId)
    ) {
      this.setUnwritten(undefined);
    }
    return sessions;
  }

  /**
   * The row the server's listing cannot produce, for a session whose first
   * line has not reached disk yet.
   *
   * A new chat nobody has typed into yet gets no row at all: an empty
   * composer is not a conversation, and a row for it would be the sidebar
   * listing the button that made it.
   */
  public unwrittenSummary(): UnwrittenSummary | undefined {
    const unwritten = this.state.unwritten;
    if (!unwritten) {
      return undefined;
    }
    if (!unwritten.sent && this.localTitle(unwritten.sessionId) === undefined) {
      return undefined;
    }
    return { sessionId: unwritten.sessionId, cwd: unwritten.cwd };
  }

  /**
   * What a session is called when the listing has no name for it: a session
   * is its opening message, and one that has not been sent yet is the message
   * about to open it. Never the other way round — a second message being
   * typed into a conversation does not rename it.
   *
   * The same rule the listing uses, which is why the two agree the moment pi
   * writes the log: what this covers is the gap before it does, where the row
   * would otherwise fall back to an id it already had a name for.
   */
  public localTitle(sessionId: string): string | undefined {
    const opening =
      sessionId === this.state.sessionId
        ? this.firstUserText()
        : // A session left behind by a switch has no transcript here, so what
          // it was opened with is only known if this browser is what opened
          // it — which, for the whole of the gap this covers, it is.
          this.state.openings[sessionId];
    const title = opening?.trim() || this.draftText(sessionId).trim();
    return title === "" ? undefined : title;
  }

  /** The unsent message typed into a session; empty when there is none. */
  public draftText(sessionId: string): string {
    return this.state.drafts[sessionId] ?? "";
  }

  /**
   * The files waiting to go with a session's unsent message. Held per
   * session for the same reason the words are: the composer is one box that
   * every session borrows, and a photo dropped into one conversation is not
   * a photo dropped into the next one the reader opens.
   */
  public attachmentsOf(sessionId: string): readonly UploadedAttachment[] {
    return this.state.attachments[sessionId] ?? [];
  }

  /**
   * Moves bytes into the server's world and files them under the session
   * they were meant for — which is read once, here, so a switch mid-upload
   * lands them where they were dropped rather than where the reader has got
   * to since. The `File` the browser handed us never leaves this method, and
   * its client-local path was never available to begin with.
   */
  public async attachFile(file: File): Promise<UploadedAttachment> {
    const sessionId = this.state.sessionId;
    const form = new FormData();
    form.append("file", file, file.name);
    const response = await fetch(
      `${this.client.httpUrl}/upload?session=${encodeURIComponent(sessionId)}`,
      { method: "POST", body: form }
    );
    const body = (await response.json()) as {
      readonly id: string;
      readonly url: string;
      readonly isImage: boolean;
      readonly error?: string;
    };
    if (!response.ok) {
      throw new Error(body.error ?? `upload failed: ${response.status}`);
    }
    const uploaded: UploadedAttachment = {
      id: body.id,
      url: this.absolute(body.url),
      isImage: body.isImage,
      name: file.name,
    };
    this.setState((draft) => {
      draft.attachments[sessionId] = [
        ...(draft.attachments[sessionId] ?? []),
        uploaded,
      ];
    });
    return uploaded;
  }

  /** Takes one back off the unsent message. The bytes stay on the server. */
  public detachFile(sessionId: string, id: string): void {
    this.setState((draft) => {
      const kept = (draft.attachments[sessionId] ?? []).filter(
        (one) => one.id !== id
      );
      if (kept.length === 0) {
        delete draft.attachments[sessionId];
      } else {
        draft.attachments[sessionId] = kept;
      }
    });
  }

  /**
   * Mirrors the composer's unsent message onto the session it is being typed
   * into. Which session that is, is the store's answer and not the box's:
   * the composer is one box shared by every session.
   */
  public setDraftText(text: string): void {
    this.putDraft(this.state.sessionId, text);
  }

  private putDraft(sessionId: string, text: string): void {
    if (sessionId === "" || (this.drafts[sessionId] ?? "") === text) {
      return;
    }
    // An empty draft is no draft, and deleting rather than storing `""` is
    // what keeps this from growing one entry per session ever opened.
    if (text === "") {
      delete this.drafts[sessionId];
    } else {
      this.drafts[sessionId] = text;
    }
    this.setState((state) => {
      if (text === "") {
        delete state.drafts[sessionId];
      } else {
        state.drafts[sessionId] = text;
      }
    });
    this.persist(DRAFTS_KEY, () => JSON.stringify(this.drafts));
  }

  /**
   * The message is on its way, so the box it left is empty. An unwritten
   * session keeps its row — nothing else can draw one until pi has written
   * the log — but it is a conversation from here, named by what was sent
   * rather than by what is typed.
   */
  private spendDraft(): void {
    this.putDraft(this.state.sessionId, "");
    const sessionId = this.state.sessionId;
    this.setState((draft) => {
      delete draft.attachments[sessionId];
    });
    const unwritten = this.state.unwritten;
    if (unwritten && unwritten.sessionId === this.state.sessionId) {
      this.setUnwritten({ ...unwritten, sent: true });
    }
  }

  /**
   * The message the unwritten session opens with, if it has one. Only the
   * attached session's content is readable here; one left behind by a switch
   * has nothing but what was typed into it.
   */
  private openingText(unwritten: Unwritten): string | undefined {
    return unwritten.sessionId === this.state.sessionId
      ? this.firstUserText()
      : undefined;
  }

  private setUnwritten(unwritten: Unwritten | undefined): void {
    this.setState((state) => {
      state.unwritten = unwritten;
    });
    // Written from the value just set rather than read back at flush time:
    // a store write lands on its own schedule, and storage must not be told
    // what state was before it did.
    const written =
      unwritten === undefined ? undefined : JSON.stringify(unwritten);
    this.persist(UNWRITTEN_KEY, () => written);
  }

  private firstUserText(): string | undefined {
    return openingMessage(this.state.durable, this.state.optimistic);
  }

  /**
   * The models this server can switch to and the levels the current one
   * thinks at. Cached for the connection's lifetime: both are properties of
   * the machine the server runs on, and a menu that re-queried on every open
   * would ask the same question every time it was looked at.
   */
  public listModels(): Promise<ModelCatalogue> {
    this.catalogue ??= this.client
      .send({ type: "list_models" })
      .then((response) => ({
        models: response.models ?? [],
        thinkingLevels: response.thinkingLevels ?? [],
      }))
      .catch(() => {
        this.catalogue = undefined;
        return { models: [], thinkingLevels: [] };
      });
    return this.catalogue;
  }

  public async setModel(id: string): Promise<void> {
    await this.set("set_model", id);
  }

  public async setThinking(level: string): Promise<void> {
    await this.set("set_thinking", level);
  }

  /** True when the session has answered since anything last read it. */
  public isUnread(sessionId: string): boolean {
    return this.state.unread[sessionId] ?? false;
  }

  /**
   * Queues one key's write. The value is a thunk so a caller whose value is
   * expensive — the read cursor, re-serialised once per replayed event —
   * pays for the write that actually happens rather than for each one
   * coalesced away. `undefined` removes the key.
   */
  private persist(key: string, value: () => string | undefined): void {
    const flushing = this.writes.size > 0;
    this.writes.set(key, value);
    if (flushing) {
      return;
    }
    queueMicrotask(() => {
      const pending = [...this.writes];
      this.writes.clear();
      for (const [name, read] of pending) {
        const written = read();
        try {
          if (written === undefined) {
            localStorage.removeItem(name);
          } else {
            localStorage.setItem(name, written);
          }
        } catch {
          // Private mode, a full quota, or no storage at all. Both of these
          // are niceties: a draft and a session id that survive a reload.
        }
      }
    });
  }

  private async set(
    type: "set_model" | "set_thinking",
    value: string
  ): Promise<void> {
    await this.client
      .send({ type, sessionId: this.state.sessionId, value })
      .catch(() => undefined);
  }

  public async switchTo(sessionId: string): Promise<void> {
    // Re-attaching replays the log from `seq: 0`, and this client keeps what
    // it already painted for the session it is already on — so asking for the
    // session you are reading would print it twice. Picking it again is a
    // navigation, and the caller answers it by scrolling.
    if (sessionId === this.state.sessionId) {
      return;
    }
    await this.attach({ sessionId });
  }

  /**
   * A second press while a new chat is open is not a second session: there is
   * one unwritten session at a time, and asking for a new chat while holding
   * one is a request to go back to it.
   */
  public async newSession(cwd?: string): Promise<void> {
    const unwritten = this.state.unwritten;
    if (
      unwritten &&
      !unwritten.sent &&
      this.openingText(unwritten) === undefined
    ) {
      await this.switchTo(unwritten.sessionId).catch(async () => {
        await this.restart(unwritten);
      });
      return;
    }
    await this.startDraft("", cwd);
  }

  /**
   * The gateway has forgotten the unwritten session — it restarted under us —
   * so the id is gone and only the message typed into it is worth carrying
   * into its replacement.
   */
  private async restart(unwritten: Unwritten): Promise<void> {
    const typed = this.draftText(unwritten.sessionId);
    this.putDraft(unwritten.sessionId, "");
    await this.startDraft(typed, unwritten.cwd);
  }

  /** Attaches to a session the server is about to make, and claims it. */
  private async startDraft(
    text: string,
    cwd: string | undefined
  ): Promise<void> {
    this.claimed = text;
    try {
      await this.attach(cwd ? { cwd } : {});
    } catch (error) {
      this.claimed = undefined;
      throw error;
    }
  }

  /**
   * The curtain goes up on the click, not on the answer: a session the server
   * does not already have in memory takes a moment to resume, and until it
   * answers the screen would otherwise still show the conversation being left.
   */
  private async attach(target: AttachTarget): Promise<void> {
    this.setState((draft) => {
      draft.loading = true;
    });
    try {
      const response = await this.client.attachTo(target);
      if (!response.success) {
        throw new Error(response.error ?? "attach was refused");
      }
    } catch (error) {
      // Reported here rather than by the caller: every one of them is a
      // click, and a click has nowhere to put an exception. The `attached`
      // frame clears it, so an attach that recovers by making another
      // session leaves nothing behind.
      this.setState((draft) => {
        draft.loading = false;
        draft.error = (error as Error).message;
      });
      throw error;
    }
  }

  /**
   * A URL the server sent, as this browser can actually fetch it. Server
   * frames carry server-relative paths — where this server is reachable is
   * the client's business, and in development the page is served by vite on
   * a different port than the gateway holding the socket.
   */
  private absolute(url: string): string {
    return url.startsWith("/") ? `${this.client.httpUrl}${url}` : url;
  }

  /** The one entry point for a server frame; tests drive it directly. */
  public ingest(event: ServerEvent): void {
    this.update.ingest(event);
    if (isDurableEvent(event)) {
      this.ingestDurable(event);
      return;
    }
    switch (event.type) {
      // Applied in order and in one task, so the store settles once and the
      // transcript is painted once, however long the conversation is.
      case "replay":
        for (const inner of event.events) {
          this.ingest(inner);
        }
        return;
      case "attached": {
        const previous = this.state.sessionId;
        this.setState((draft) => {
          // A different session means a different log, so the ordinals this
          // client holds mean nothing; the same one means resume, and the
          // tail it is about to be sent continues what it already has.
          if (draft.sessionId !== event.sessionId) {
            draft.durable = [];
            draft.optimistic = [];
            // A resume of the same session keeps what is on screen and needs
            // no curtain; a different one has nothing to show until its log
            // lands, and half a log painting itself is worse than a wait.
            draft.loading = event.head > 0;
          }
          draft.sessionId = event.sessionId;
          draft.cwd = event.cwd;
          // The server re-sends the whole in-flight turn on every attach, so
          // keeping any of it here would double the text.
          draft.live = [];
          draft.error = undefined;
        });
        // A chat the reader just started: the server has named it, so the
        // message typed into it now has somewhere to live.
        if (this.claimed !== undefined) {
          this.setUnwritten({
            sessionId: event.sessionId,
            cwd: event.cwd,
            sent: false,
          });
          this.putDraft(event.sessionId, this.claimed);
          this.claimed = undefined;
        }
        this.rewatch(previous, event.sessionId);
        return;
      }
      case "message_start":
      case "message_retire":
      case "text_delta":
      case "thinking_delta":
      case "tool_call":
      case "tool_update":
      case "tool_end":
        this.setState((draft) => {
          applyLive(draft, event);
        });
        return;
      case "subagent_events":
        this.setState((draft) => {
          const watched = draft.subagent;
          // An envelope for a watch this client has already dropped: the
          // server was still sending when the modal closed.
          if (watched?.callId !== event.callId) {
            return;
          }
          for (const inner of event.events) {
            applyChild(watched, this.resolveAttachments(inner));
          }
        });
        return;
      case "picker_invalidate":
        void this.files.refreshRelative();
        return;
      case "session_activity":
        this.setState((draft) => {
          draft.activity[event.sessionId] = event.status;
        });
        return;
      case "session_read":
        this.setState((draft) => {
          draft.unread[event.sessionId] = false;
        });
        return;
      case "session_state":
        this.setState((draft) => {
          // The last event of a replay, so this is where the log is complete
          // and the transcript can be shown — in one paint, at its end.
          draft.loading = false;
          draft.cwd = event.cwd;
          draft.model = event.model;
          draft.modelLabel = event.modelLabel ?? event.model;
          draft.thinking = event.thinking;
          draft.cost = event.cost;
          draft.agent = event.status;
          // The attached session is announced like any other, but not on the
          // attach itself: nothing transitioned, so this is where a session
          // already mid-turn when it was opened gets its mark.
          draft.activity[draft.sessionId] = event.status;
          draft.tps = event.tps;
          draft.contextPercent = event.contextPercent;
          draft.contextWindow = event.contextWindow;
          draft.branch = event.branch;
          draft.dirtyCount = event.dirtyCount ?? 0;
          draft.ahead = event.ahead ?? 0;
          draft.behind = event.behind ?? 0;
          // The server only says `idle` after it has flushed every entry the
          // turn wrote, so anything still live here has been superseded and
          // would otherwise sit under the durable copy of itself forever.
          if (event.status === "idle") {
            draft.live = [];
          }
        });
        return;
      case "turn_end":
        this.setState((draft) => {
          draft.stats = event.stats;
        });
        return;
      case "error":
        this.setState((draft) => {
          draft.error = event.message;
        });
        return;
      default:
        return;
    }
  }

  private ingestDurable(event: DurableEvent): void {
    const resolved = this.resolveAttachments(event);
    this.setState((draft) => {
      draft.durable.push(resolved);
      if (event.type === "message" && event.role === "user") {
        // Splicing a store draft in place is not safe across a batch of
        // events — the write is a patch, and it can be applied against a
        // later array than the one the index was read from.
        const at = draft.optimistic.findIndex((pending) =>
          event.text.startsWith(pending.text)
        );
        draft.optimistic = draft.optimistic.filter(
          (_, index) => index !== (at === -1 ? 0 : at)
        );
      }
      if (event.type === "tool_result") {
        settleLiveTool(draft, event.callId);
      }
    });
  }

  /**
   * The files a message carried, where this browser can fetch them. Server
   * frames carry server-relative paths, and a child's message is served by
   * the same gateway the session's is.
   */
  private resolveAttachments<TEvent extends StreamEvent>(
    event: TEvent
  ): TEvent {
    if (event.type !== "message" || !event.attachments) {
      return event;
    }
    return {
      ...event,
      attachments: event.attachments.map((file) => ({
        ...file,
        url: this.absolute(file.url),
      })),
    };
  }

  /**
   * A watch does not survive the socket that asked for it, and does not
   * follow a reader to another session. So a modal still open over a session
   * that has just re-attached asks again, from the child's first entry —
   * ordinals already painted are dropped on the way back in — and one over a
   * session being left closes with it.
   */
  private rewatch(previous: string, sessionId: string): void {
    const watched = this.state.subagent;
    if (!watched) {
      return;
    }
    if (previous !== sessionId) {
      this.setState((draft) => {
        draft.subagent = undefined;
      });
      return;
    }
    void this.sendWatch(watched.callId, 0);
  }

  /**
   * Undoes a send the server refused: the row goes if this send made it, and
   * shrinks back to `previous` if the send only added to one.
   */
  private rollback(id: string, previous: string | undefined): void {
    this.setState((draft) => {
      if (previous === undefined) {
        draft.optimistic = draft.optimistic.filter(
          (pending) => pending.id !== id
        );
        return;
      }
      const grown = draft.optimistic.find((pending) => pending.id === id);
      if (grown) {
        grown.text = previous;
      }
    });
  }

  /** Retires the row for the message pi handed back rather than said. */
  private dropQueued(): void {
    this.setState((draft) => {
      draft.optimistic = draft.optimistic.filter((pending) => !pending.queued);
    });
  }
}

/**
 * The live message with this id, appended if this is the first sight of it.
 * Any of the turn's events may be the first to name a message — a replay
 * arrives mid-turn, and a step that only calls a tool never streams a word.
 */
function liveMessage(live: LiveMessage[], messageId: string): LiveMessage {
  const existing = live.find((message) => message.messageId === messageId);
  if (existing) {
    return existing;
  }
  const message: LiveMessage = {
    messageId,
    text: "",
    thinking: "",
    tools: [],
    retired: false,
  };
  live.push(message);
  return message;
}

/**
 * The bucket a turn in flight is held in — the session's, or a watched
 * subagent's. Taken as a whole rather than as its array because dropping a
 * message from one is a write to the field: a store draft is patched, and a
 * splice through the patch is not the same edit as the array it replaces.
 */
type LiveHolder = { live: LiveMessage[] };

/**
 * One event of a turn in flight, folded into the bucket holding it. Shared by
 * the session and by a watched subagent, because a child's turn is a turn:
 * what differs between them is which bucket it lands in, and nothing else.
 */
function applyLive(target: LiveHolder, event: EphemeralEvent): void {
  switch (event.type) {
    case "message_start":
      liveMessage(target.live, event.messageId);
      return;
    case "text_delta":
      liveMessage(target.live, event.messageId).text += event.delta;
      return;
    case "thinking_delta":
      liveMessage(target.live, event.messageId).thinking += event.delta;
      return;
    case "tool_call": {
      // Onto the message being streamed: pi calls tools from the step it just
      // wrote, and that is the order the transcript draws them in.
      const message = liveMessage(target.live, event.messageId);
      if (message.tools.every((tool) => tool.callId !== event.callId)) {
        message.tools.push({
          callId: event.callId,
          name: event.name,
          view: event.view,
          isError: false,
          isPartial: true,
        });
      }
      return;
    }
    case "tool_update":
      patchLiveTool(target.live, event.callId, { view: event.view });
      return;
    case "tool_end":
      patchLiveTool(target.live, event.callId, {
        view: event.view,
        isError: event.isError,
        isPartial: false,
      });
      return;
    case "message_retire":
      // The durable copy of this message arrived in the same frame, so
      // dropping its prose here is a swap, not a gap. Its calls are not
      // superseded with it — each of them leaves separately, on the durable
      // result that answers for it.
      target.live = target.live.flatMap((message) => {
        if (message.messageId !== event.messageId) {
          return [message];
        }
        return message.tools.length === 0
          ? []
          : [{ ...message, text: "", thinking: "", retired: true }];
      });
      return;
    default:
      return;
  }
}

/** Rewrites one live call wherever in the turn it was made. */
function patchLiveTool(
  live: LiveMessage[],
  callId: string,
  patch: Partial<Omit<LiveTool, "callId" | "name">>
): void {
  for (const message of live) {
    const at = message.tools.findIndex((tool) => tool.callId === callId);
    const existing = message.tools[at];
    if (existing) {
      message.tools[at] = { ...existing, ...patch };
      return;
    }
  }
}

/** The call has been written down, so the live view of it is superseded. */
function settleLiveTool(target: LiveHolder, callId: string): void {
  for (const message of target.live) {
    message.tools = message.tools.filter((tool) => tool.callId !== callId);
  }
  // A retired message is kept for its calls alone, so the last result to be
  // written is what takes the shell with it.
  target.live = target.live.filter(
    (message) => !message.retired || message.tools.length > 0
  );
}

/**
 * One event of a child's log, folded into the modal reading it. Applied here
 * rather than through `ingest` for the reason the envelope exists at all: a
 * child's messages carry ordinals of their own, and taken for the session's
 * they would land in the conversation.
 */
function applyChild(target: SubagentTranscript, event: StreamEvent): void {
  if (!isDurableEvent(event)) {
    applyLive(target, event);
    return;
  }
  // A watch cannot be resumed across a reconnect, so a re-opened one starts
  // at the child's first entry; the child's own ordinals say which of those
  // this modal has already painted.
  if (event.seq <= (target.events.at(-1)?.seq ?? 0)) {
    return;
  }
  target.events.push(event);
  if (event.type === "tool_result") {
    settleLiveTool(target, event.callId);
  }
}

function readDrafts(): Record<string, string> {
  return readRecord<string>(DRAFTS_KEY);
}

/**
 * The message a session opens with: the first one written, and before it is
 * written the first one said. One rule, because a name that changed when the
 * echo landed would be two.
 */
function openingMessage(
  durable: readonly DurableEvent[],
  optimistic: readonly OptimisticMessage[]
): string | undefined {
  for (const event of durable) {
    if (event.type === "message" && event.role === "user") {
      return event.text || namesOf(event.attachments);
    }
  }
  const first = optimistic[0];
  return first && (first.text || namesOf(first.attachments));
}

/**
 * What to call a message that is only files, which is how the server names
 * one too: a row reading "Untitled" says less than the photo it stands for.
 */
function namesOf(attachments: readonly AttachmentView[] | undefined): string {
  return (attachments ?? []).map((file) => file.name).join(", ");
}

/** Anything storage has none of, or has nonsense in, reads as empty. */
function readRecord<T>(key: string): Record<string, T> {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? {} : (JSON.parse(raw) as Record<string, T>);
  } catch {
    return {};
  }
}

function readUnwritten(): Unwritten | undefined {
  try {
    const raw = localStorage.getItem(UNWRITTEN_KEY);
    const held = raw === null ? undefined : (JSON.parse(raw) as Unwritten);
    return typeof held?.sessionId === "string" ? held : undefined;
  } catch {
    return undefined;
  }
}
