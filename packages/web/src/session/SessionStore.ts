import { createStore, type Store, type StoreSetter } from "solid-js";

import type { PickerItem } from "#core/picker/PickerItem";
import { RemoteFilePickerSuggestionEngine } from "#core/picker/RemoteFilePickerSuggestionEngine";
import type { ToolView } from "#core/view/ViewBlock";
import type { AttachmentRef, CommandDraft } from "#protocol/Command";
import type {
  DurableEvent,
  ModelView,
  ServerEvent,
  SessionStatus,
  SessionSummaryView,
  TurnStats,
} from "#protocol/ServerEvent";
import { isDurableEvent } from "#protocol/ServerEvent";
import {
  WsClient,
  type AttachTarget,
  type ConnectionStatus,
} from "../ws/WsClient";

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
};

/** What the composer's two chips choose from; one query answers both. */
export type ModelCatalogue = {
  readonly models: readonly ModelView[];
  readonly thinkingLevels: readonly string[];
};

/** What `POST /upload` answered with. Every path here is the server's. */
export type UploadedAttachment = {
  readonly id: string;
  readonly path: string;
  readonly mimeType: string;
  readonly isImage: boolean;
  /** The client's own name for the bytes, kept for the chip and nothing else. */
  readonly label: string;
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
  /** Highest durable seq this browser has painted, per session. */
  seen: Record<string, number>;
  /**
   * The composer's unsent message, per session. The box belongs to the
   * session it is typed into rather than to the page, so switching swaps
   * what is in it and leaves the other message where it was written.
   */
  drafts: Record<string, string>;
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
};

export type SessionStoreOptions = {
  readonly url: string;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly backoffMs?: (attempt: number) => number;
  /** Picker debounce; 0 in tests. */
  readonly pickerDebounceMs?: number;
};

const FILE_PICKER_LIMIT = 50;
const COMMAND_PICKER_LIMIT = 20;

/**
 * Where the read cursor of every session lives. Unread is a property of this
 * browser, not of the conversation — a second client reading the same session
 * has its own answer — so it is stored here and never sent.
 */
const SEEN_KEY = "pim.seen";

/**
 * Where the unsent messages and the id of the unwritten session live across a
 * reload. Local to this browser for the same reason the read cursor is: an
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
  /** The `@` picker, answered one query at a time by the server. */
  public readonly files: RemoteFilePickerSuggestionEngine;
  public readonly state: Store<SessionState>;
  private readonly setState: StoreSetter<SessionState>;
  private optimisticId = 0;
  /** The catalogue is a property of the server, so one query per connection. */
  private catalogue: Promise<ModelCatalogue> | undefined;
  /**
   * The read cursors, synchronously. The store copy is the same numbers, but
   * a batch of events writes it many times before anything reads it back, so
   * the guard and the persisted value are taken from here.
   */
  private readonly seen: Record<string, number>;
  /** The unsent messages, synchronously, for the same reason as `seen`. */
  private readonly drafts: Record<string, string>;
  /**
   * Pending `localStorage` writes, one per key. Both things stored here move
   * far faster than a reload can read them — the cursor once per replayed
   * event, the draft once per keystroke — and `localStorage` is synchronous
   * disk, so the writes are coalesced onto the next microtask: what a reload
   * needs is where a value ended up, not each place it passed through.
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
    const seen = readSeen();
    const drafts = readDrafts();
    // An unwritten session has no file, so nothing but this browser remembers
    // it; resuming it is the whole reason the id was written down.
    const unwritten = readUnwritten();
    const sessionId = options.sessionId ?? unwritten?.sessionId;
    const cwd = options.cwd ?? unwritten?.cwd;
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
      seen: { ...seen },
      drafts: { ...drafts },
      openings: {},
      unwritten,
    });
    this.seen = seen;
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
  public async prompt(
    text: string,
    attachments: readonly UploadedAttachment[] = []
  ): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === "" && attachments.length === 0) {
      return;
    }
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
      } else {
        id = `optimistic:${++this.optimisticId}`;
        draft.optimistic.push({
          id,
          text: trimmed,
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
        sessionId: this.state.sessionId,
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

  /** True when the session's `head` is beyond what this browser has painted. */
  public isUnread(session: SessionSummaryView): boolean {
    return session.head > (this.state.seen[session.sessionId] ?? 0);
  }

  /**
   * The read cursor moves forward only. Persisted on the next microtask
   * rather than on the spot, because a replay moves it once per event and
   * `localStorage` is synchronous disk: what a reload needs is where the
   * cursor ended up, not each place it passed through.
   */
  private markSeen(sessionId: string, seq: number): void {
    if (sessionId === "" || (this.seen[sessionId] ?? 0) >= seq) {
      return;
    }
    this.seen[sessionId] = seq;
    this.setState((draft) => {
      draft.seen[sessionId] = seq;
    });
    this.persist(SEEN_KEY, () => JSON.stringify(this.seen));
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
          // are niceties: unread marks and a message that survives a reload.
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
   * Moves bytes into the server's world and answers with the server's own id
   * for them. The `File` the browser handed us never leaves this method, and
   * its client-local path was never available to begin with.
   */
  public async upload(file: File): Promise<UploadedAttachment> {
    const form = new FormData();
    form.append("file", file, file.name);
    const response = await fetch(
      `${this.client.httpUrl}/upload?session=${encodeURIComponent(this.state.sessionId)}`,
      { method: "POST", body: form }
    );
    const body = (await response.json()) as UploadedAttachment & {
      readonly error?: string;
    };
    if (!response.ok) {
      throw new Error(body.error ?? `upload failed: ${response.status}`);
    }
    return { ...body, label: file.name };
  }

  /** The one entry point for a server frame; tests drive it directly. */
  public ingest(event: ServerEvent): void {
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
      case "attached":
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
        // Attaching is reading: the replay that follows this frame paints
        // everything up to `head`.
        this.markSeen(event.sessionId, event.head);
        return;
      case "message_start":
        this.setState((draft) => {
          liveMessage(draft.live, event.messageId);
        });
        return;
      case "message_retire":
        this.setState((draft) => {
          // The durable copy of this message arrived on the frame before, so
          // dropping it here is a swap, not a gap.
          draft.live = draft.live.filter(
            (message) => message.messageId !== event.messageId
          );
        });
        return;
      case "text_delta":
        this.setState((draft) => {
          const message = liveMessage(draft.live, event.messageId);
          message.text += event.delta;
        });
        return;
      case "thinking_delta":
        this.setState((draft) => {
          const message = liveMessage(draft.live, event.messageId);
          message.thinking += event.delta;
        });
        return;
      case "tool_call":
        this.setState((draft) => {
          // Onto the message being streamed: pi calls tools from the step it
          // just wrote, and that is the order the transcript draws them in.
          const message = liveMessage(draft.live, event.messageId);
          if (message.tools.every((tool) => tool.callId !== event.callId)) {
            message.tools.push({
              callId: event.callId,
              name: event.name,
              view: event.view,
              isError: false,
              isPartial: true,
            });
          }
        });
        return;
      case "tool_update":
        this.patchTool(event.callId, { view: event.view });
        return;
      case "tool_end":
        this.patchTool(event.callId, {
          view: event.view,
          isError: event.isError,
          isPartial: false,
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
    this.setState((draft) => {
      draft.durable.push(event);
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
        for (const message of draft.live) {
          message.tools = message.tools.filter(
            (tool) => tool.callId !== event.callId
          );
        }
      }
    });
    this.markSeen(this.state.sessionId, event.seq);
  }

  /** Rewrites one live call wherever in the turn it was made. */
  private patchTool(
    callId: string,
    patch: Partial<Omit<LiveTool, "callId" | "name">>
  ): void {
    this.setState((draft) => {
      for (const message of draft.live) {
        const at = message.tools.findIndex((tool) => tool.callId === callId);
        const existing = message.tools[at];
        if (existing) {
          message.tools[at] = { ...existing, ...patch };
          return;
        }
      }
    });
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
  };
  live.push(message);
  return message;
}

function readSeen(): Record<string, number> {
  return readRecord<number>(SEEN_KEY);
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
      return event.text;
    }
  }
  return optimistic[0]?.text;
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
