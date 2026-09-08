import { createStore, untrack, type Store, type StoreSetter } from "solid-js";

import type { PickerItem } from "#core/picker/PickerItem";
import { rankCommands } from "#core/picker/commandRanker";
import { RemoteFilePickerSuggestionEngine } from "#core/picker/RemoteFilePickerSuggestionEngine";
import type { DirectoryListing } from "#core/shared/Directories";
import type { AttachmentRef, CommandDraft } from "#protocol/Command";
import type {
  AttachmentView,
  DurableEvent,
  ModelView,
  ServerEvent,
  SessionStatus,
  SessionSummaryView,
} from "#protocol/ServerEvent";
import { isDurableEvent } from "#protocol/ServerEvent";
import {
  WsClient,
  type AttachTarget,
  type ConnectionStatus,
} from "../ws/WsClient";
import {
  Drafts,
  readDrafts,
  readUnwritten,
  type Unwritten,
  type UnwrittenSummary,
} from "./Drafts";
import {
  applyChild,
  applyLive,
  ingestDurable,
  openingMessage,
  resolveUrls,
  type LiveMessage,
  type OptimisticMessage,
  type PendingMessage,
  type SubagentTranscript,
} from "./fold";
import { Reload } from "./Reload";

export type {
  LiveMessage,
  LiveTool,
  PendingMessage,
  SubagentTranscript,
} from "./fold";
export type { Unwritten, UnwrittenSummary } from "./Drafts";

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
 * Store state is a draft the setter mutates, so its fields are deliberately
 * mutable; consumers only ever see it through the readonly `Store<T>` view.
 */
export type SessionState = {
  connection: ConnectionStatus;
  sessionId: string;
  pimVersion: string | undefined;
  piVersion: string | undefined;
  cwd: string;
  /** The id `set_model` takes; `modelLabel` is what a reader is shown. */
  model: string;
  modelLabel: string;
  thinking: string;
  cost: number;
  agent: SessionStatus;
  /**
   * How long the turn in flight has been running, as the server last said
   * it. Undefined when nothing is running — and read at the moment a client
   * starts timing rather than every tick, so a turn this browser watched
   * from the start is timed by its own clock and one it walked in on is
   * anchored to the server's.
   */
  turnElapsedMs: number | undefined;
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
 * The commands this client answers itself, merged into the server's own so
 * one list is one picker. `/clear` is here rather than on the machine
 * because what it means here is not what it means in a terminal: a browser
 * keeps the old conversation in the sidebar, so clearing is opening a new
 * session beside it rather than dropping the one you have.
 */
type LocalCommand = PickerItem & {
  readonly run: (store: SessionStore) => Promise<void>;
};

const LOCAL_COMMANDS: readonly LocalCommand[] = [
  {
    value: "/clear",
    label: "/clear",
    description: "Start a new session with this one's model and directory",
    run: (store) => store.newSession(),
  },
];

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
  /** The unsent messages and the session that is nothing but one. */
  private readonly drafts: Drafts;

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
      pimVersion: undefined,
      piVersion: undefined,
      cwd: cwd ?? "",
      model: "",
      modelLabel: "",
      thinking: "",
      cost: 0,
      agent: "idle",
      turnElapsedMs: undefined,
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
      error: undefined,
      unread: {},
      drafts: { ...drafts },
      attachments: {},
      openings: {},
      unwritten,
      subagent: undefined,
    });
    this.state = state;
    this.setState = setState;
    this.drafts = new Drafts(state, setState, drafts);
    // Nothing to attach to means the server is about to make a session, and
    // a session made for this browser with nothing in it is a draft — the
    // first chat of a fresh tab belongs in the sidebar like any other.
    this.drafts.claimed = sessionId === undefined ? "" : undefined;
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
    // Answered here rather than sent: a fresh context is a new session, and
    // the words that asked for one are not a message to anybody — so the box
    // is emptied as if they had been said, or the command would name the
    // session it was typed into and come back with it on the next switch.
    const local = LOCAL_COMMANDS.find((command) => command.value === trimmed);
    if (local) {
      this.drafts.putDraft(sessionId, "");
      this.setState((draft) => {
        delete draft.attachments[sessionId];
      });
      // A refused attach is already on `state.error`; the caller is a click.
      await local.run(this).catch(() => undefined);
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
    this.drafts.spendDraft();
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
      draft.subagent = { callId, durable: [], live: [] };
    });
    await this.sendWatch(callId, 0);
  }

  /**
   * Let the child go. The server drops a watch on socket close and on an
   * attach elsewhere, but a modal closed on a live connection is neither, and
   * a watch left behind one is a projection growing for nobody.
   */
  public unwatch(): void {
    // Untracked, like every read an imperative method makes of its own
    // state: the answer wanted is the one true when it was called, and the
    // caller is as often an effect's callback as an event handler.
    const callId = untrack(() => this.state.subagent?.callId);
    if (callId === undefined) {
      return;
    }
    this.setState((draft) => {
      draft.subagent = undefined;
    });
    // Whether or not the server still holds one: closing a modal over a
    // connection that has since dropped is not a failure anyone need hear.
    void this.client
      .send({ type: "unwatch_subagent", callId })
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
    // Re-ranked rather than concatenated: the server's rows are ranked
    // against each other, and a client command dropped on either end of them
    // would sort by where it came from instead of by what was typed.
    return rankCommands(
      query,
      [...LOCAL_COMMANDS, ...(response?.items ?? [])],
      {
        limit,
      }
    );
  }

  /**
   * What is inside a directory on the server, which is the only filesystem
   * any path in this client names. Throws what the server refused with — a
   * path that has gone, or one it may not read — because a browser that
   * cannot go there has to say so rather than draw an empty directory.
   */
  public async listDirectory(path: string): Promise<DirectoryListing> {
    const response = await this.client.send({ type: "list_dirs", path });
    if (!response.success || !response.directory) {
      throw new Error(response.error ?? `could not read ${path}`);
    }
    return response.directory;
  }

  /**
   * The directories this machine has sessions in, most recent first and the
   * current one left out. The listing is already the sidebar's, so asking
   * where a reader has worked costs nothing the sidebar was not paying: a
   * session's cwd is on every row of it.
   */
  public async recentDirectories(limit = 5): Promise<readonly string[]> {
    const sessions = await this.listSessions();
    const recent: string[] = [];
    for (const session of sessions) {
      if (session.cwd !== this.state.cwd && !recent.includes(session.cwd)) {
        recent.push(session.cwd);
        if (recent.length === limit) {
          break;
        }
      }
    }
    return recent;
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
      this.drafts.setUnwritten(undefined);
    }
    return sessions;
  }

  public unwrittenSummary(): UnwrittenSummary | undefined {
    return this.drafts.unwrittenSummary();
  }

  public localTitle(sessionId: string): string | undefined {
    return this.drafts.localTitle(sessionId);
  }

  public draftText(sessionId: string): string {
    return this.drafts.draftText(sessionId);
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

  public setDraftText(text: string): void {
    this.drafts.setDraftText(text);
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

  /**
   * The level after the one in force, wrapping at the end — what Shift+Tab
   * does here and in the TUI. The order is the catalogue's, so the cycle
   * climbs the way the menu reads; a session whose level is not in the list
   * starts at the top of it rather than nowhere.
   */
  public async cycleThinking(): Promise<void> {
    const { thinkingLevels } = await this.listModels();
    const at = thinkingLevels.indexOf(this.state.thinking);
    const next = thinkingLevels[(at + 1) % thinkingLevels.length];
    if (next !== undefined) {
      await this.setThinking(next);
    }
  }

  /** True when the session has answered since anything last read it. */
  public isUnread(sessionId: string): boolean {
    return this.state.unread[sessionId] ?? false;
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
   *
   * Takes no directory and no model: a new session is opened *like* the one
   * it was asked for from, which the server resolves. A reader asks for a
   * fresh context, not for a fresh set of settings — those they chose.
   */
  public async newSession(): Promise<void> {
    const unwritten = this.state.unwritten;
    if (
      unwritten &&
      !unwritten.sent &&
      this.drafts.openingText(unwritten) === undefined
    ) {
      await this.switchTo(unwritten.sessionId).catch(async () => {
        await this.restart(unwritten);
      });
      return;
    }
    await this.startDraft("");
  }

  /**
   * Work somewhere else. Always a new session rather than a move of this one:
   * pi writes a session's log inside a directory named for its cwd, so a
   * conversation cannot change directory without leaving its own transcript
   * behind — and a fresh session in the new place is what a reader picking a
   * directory is asking for anyway.
   */
  public async openDirectory(cwd: string): Promise<void> {
    const unwritten = this.state.unwritten;
    // A new chat nobody has sent from is not worth keeping a second copy of,
    // and the words typed into it were typed for the session about to open,
    // so they move with the reader rather than being stranded on a row that
    // is about to disappear.
    if (
      unwritten &&
      !unwritten.sent &&
      unwritten.sessionId === this.state.sessionId
    ) {
      await this.restart(unwritten, cwd);
      return;
    }
    await this.startDraft("", cwd);
  }

  /**
   * Open the unwritten session's replacement, carrying what was typed into
   * it. Its id is worth nothing to anybody else — the gateway has forgotten
   * it, or the reader has moved on from where it was made — but the message
   * that was never sent is still the message they are writing.
   */
  private async restart(
    unwritten: Unwritten,
    cwd = unwritten.cwd
  ): Promise<void> {
    const typed = this.drafts.takeDraft(unwritten.sessionId);
    try {
      await this.startDraft(typed, cwd);
    } catch (error) {
      // Nothing was replaced, so the words belong where they were written:
      // this is the one path that has already taken them out of the box.
      this.drafts.putDraft(unwritten.sessionId, typed);
      throw error;
    }
  }

  /**
   * Attaches to a session the server is about to make, and claims it. The
   * session being left is named as the one to open it like, so the model and
   * the thinking level a reader chose survive a new chat; the directory does
   * too, unless this is the request that moves it.
   *
   * The directory is sent as well as implied, because `like` is a hint a
   * server that has restarted cannot honour — and a new chat that lands in
   * the daemon's own directory rather than the reader's is the one failure
   * here nobody would think to check for.
   */
  private async startDraft(text: string, cwd?: string): Promise<void> {
    const like = this.state.sessionId;
    const where = cwd ?? this.state.cwd;
    this.drafts.claimed = text;
    try {
      await this.attach({
        ...(where === "" ? {} : { cwd: where }),
        ...(like === "" ? {} : { like }),
      });
    } catch (error) {
      this.drafts.claimed = undefined;
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

  /** `absolute` as a value, for the block walk to carry. */
  private readonly toAbsolute = (url: string): string => this.absolute(url);

  /** The one entry point for a server frame; tests drive it directly. */
  public ingest(frame: ServerEvent): void {
    // Every URL a frame carries becomes fetchable here, once, before anything
    // reads it: the alternative is a base URL threaded down to the painters
    // through every layer of the transcript.
    const event = resolveUrls(frame, this.toAbsolute);
    this.update.ingest(event);
    if (isDurableEvent(event)) {
      this.setState((draft) => {
        ingestDurable(draft, event);
      });
      return;
    }
    switch (event.type) {
      case "attached": {
        const previous = this.state.sessionId;
        this.setState((draft) => {
          // A different session means a different log, so the ordinals this
          // client holds mean nothing; the same one means resume, and the
          // tail it is about to be sent continues what it already has.
          if (draft.sessionId !== event.sessionId) {
            draft.durable = [];
            draft.optimistic = [];
            // What the session being left was doing is not what this one is
            // doing, and the frame that says so is a round trip away: until
            // it lands, the honest answer is the one the listing gave for
            // *this* session, so nothing here spins on the outgoing turn.
            draft.agent = draft.activity[event.sessionId] ?? "idle";
            draft.turnElapsedMs = undefined;
            // A resume of the same session keeps what is on screen and needs
            // no curtain; a different one has nothing to show until its log
            // lands, and half a log painting itself is worse than a wait.
            draft.loading = event.head > 0;
          }
          draft.sessionId = event.sessionId;
          draft.cwd = event.cwd;
          draft.pimVersion = event.pimVersion;
          draft.piVersion = event.piVersion;
          // The server re-sends the whole in-flight turn on every attach, so
          // keeping any of it here would double the text.
          draft.live = [];
          draft.error = undefined;
        });
        // A chat the reader just started: the server has named it, so the
        // message typed into it now has somewhere to live.
        this.drafts.claim(event.sessionId, event.cwd);
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
            applyChild(watched, resolveUrls(inner, this.toAbsolute));
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
          draft.turnElapsedMs = event.turnElapsedMs;
          // The attached session is announced like any other, but not on the
          // attach itself: nothing transitioned, so this is where a session
          // already mid-turn when it was opened gets its mark.
          draft.activity[draft.sessionId] = event.status;
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
      case "error":
        this.setState((draft) => {
          draft.error = event.message;
        });
        return;
      default:
        return;
    }
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
