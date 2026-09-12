import { createStore, untrack, type Store, type StoreSetter } from "solid-js";

import type { PickerItem } from "#core/picker/PickerItem";
import { rankCommands } from "#core/picker/commandRanker";
import { RemoteFilePickerSuggestionEngine } from "#core/picker/RemoteFilePickerSuggestionEngine";
import type { DirectoryListing } from "#core/shared/Directories";
import type { GitBranch } from "#core/shared/Git";
import type { AttachmentRef, CommandDraft } from "#protocol/Command";
import type {
  ChangeList,
  DiffBase,
  FileDiff,
  FileLines,
  LineSpan,
} from "#protocol/Diff";
import type {
  AttachmentView,
  DurableEvent,
  EphemeralEvent,
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

export type ModelCatalogue = {
  readonly models: readonly ModelView[];
  readonly thinkingLevels: readonly string[];
};

/** Who holds this session's turn lease, when it is not us. */
export type LeaseHolder = Extract<
  EphemeralEvent,
  { readonly type: "session_state" }
>["heldBy"];

/** A file the server is holding for the next message. */
export type UploadedAttachment = {
  readonly id: string;
  readonly url: string;
  readonly isImage: boolean;
  readonly name: string;
};

export type SessionState = {
  connection: ConnectionStatus;
  sessionId: string;
  pimVersion: string | undefined;
  piVersion: string | undefined;
  cwd: string;
  model: string;
  modelLabel: string;
  thinking: string;
  cost: number;
  agent: SessionStatus;
  /** False while another process holds this session's turn lease. */
  writable: boolean;
  /** A session in the same directory is mid-turn, so nothing may move the repository under it. */
  repoBusy: boolean;
  heldBy: LeaseHolder;
  turnElapsedMs: number | undefined;
  contextPercent: number | undefined;
  contextWindow: number | undefined;
  branch: string | undefined;
  dirtyCount: number;
  ahead: number;
  behind: number;
  durable: DurableEvent[];
  live: LiveMessage[];
  optimistic: OptimisticMessage[];
  activity: Record<string, SessionStatus>;
  /** Bumped whenever the server says the sessions on disk moved; a listing read before it is stale. */
  catalogue: number;
  loading: boolean;
  error: string | undefined;
  unread: Record<string, boolean>;
  drafts: Record<string, string>;
  attachments: Record<string, readonly UploadedAttachment[]>;
  openings: Record<string, string>;
  unwritten: Unwritten | undefined;
  subagent: SubagentTranscript | undefined;
};

export type SessionStoreOptions = {
  readonly url: string;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly backoffMs?: (attempt: number) => number;
  readonly pickerDebounceMs?: number;
  readonly reloadPage?: () => void;
};

const FILE_PICKER_LIMIT = 50;
const COMMAND_PICKER_LIMIT = 20;

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
 */
export class SessionStore {
  public readonly client: WsClient;
  public readonly update: Reload;
  public readonly files: RemoteFilePickerSuggestionEngine;
  public readonly state: Store<SessionState>;
  private readonly setState: StoreSetter<SessionState>;
  private optimisticId = 0;
  private catalogue: Promise<ModelCatalogue> | undefined;
  private readonly drafts: Drafts;

  public constructor(options: SessionStoreOptions) {
    this.update = new Reload(options.url, options.reloadPage);
    const drafts = readDrafts();
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
      writable: true,
      repoBusy: false,
      heldBy: undefined,
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
      catalogue: 0,
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

  /** This client's own unacknowledged messages: typed, not yet echoed back. */
  public trailing(): readonly PendingMessage[] {
    return this.state.optimistic;
  }

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

  /** Another surface holds the turn lease, so every intent that would write is refused. */
  public isHeld(): boolean {
    return !this.state.writable;
  }

  /**
   * Why this session takes no writing right now, in the words the composer
   * wears; absent when it takes them. The other surface is mid-turn.
   */
  public heldNotice(): string | undefined {
    if (!this.isHeld()) {
      return undefined;
    }
    const where =
      this.state.heldBy?.frontend === "tui"
        ? "in the terminal"
        : "in another window";
    return `Running ${where} — you can continue when this turn ends.`;
  }

  /** Whether that session's agent is working, attached or not. */
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
   * Says the message. Into a running turn it joins whatever that turn is
   * already holding rather than queueing behind it. Answers whether it went:
   * a refusal and a held lease both leave the words unsaid, and whatever the
   * caller was going to clear on the strength of the send still stands.
   */
  public async prompt(text: string): Promise<boolean> {
    const trimmed = text.trim();
    const sessionId = this.state.sessionId;
    const attachments = this.attachmentsOf(sessionId);
    if (trimmed === "" && attachments.length === 0) {
      return false;
    }
    const local = LOCAL_COMMANDS.find((command) => command.value === trimmed);
    if (local) {
      this.drafts.putDraft(sessionId, "");
      this.setState((draft) => {
        delete draft.attachments[sessionId];
      });
      await local.run(this).catch(() => undefined);
      return true;
    }
    // The lease is the other surface's until its turn ends; the message keeps.
    if (this.isHeld()) {
      return false;
    }
    const carried: readonly AttachmentView[] = attachments.map(
      ({ name, url, isImage }) => ({ name, url, isImage })
    );
    const busy = this.isBusy();
    // Read inside the write: state settles later, so two sends in one tick
    // must meet in the draft.
    let id = "";
    let previous: string | undefined;
    this.setState((draft) => {
      const opens =
        openingMessage(draft.durable, draft.optimistic) === undefined;
      const growing = busy
        ? draft.optimistic.find((pending) => pending.queued)
        : undefined;
      if (growing) {
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
      this.rollback(id, previous);
      this.setState((draft) => {
        draft.error = (err as Error).message;
      });
      return false;
    }
    return true;
  }

  /** Stop the turn, and answer with the queued message that was never said. */
  public cancel(): Promise<string> {
    return this.reclaim({ type: "cancel", sessionId: this.state.sessionId });
  }

  /** Take the waiting message back to edit it, whole, leaving the turn running. */
  public dequeue(): Promise<string> {
    return this.reclaim({ type: "dequeue", sessionId: this.state.sessionId });
  }

  private async reclaim(draft: CommandDraft): Promise<string> {
    if (this.isHeld()) {
      return "";
    }
    const response = await this.client.send(draft).catch(() => undefined);
    const restored = response?.restored ?? [];
    if (restored.length > 0) {
      this.dropQueued();
    }
    return restored.join("\n\n");
  }

  /** Read one subagent's transcript, live if it is still running. */
  public async watch(callId: string): Promise<void> {
    this.setState((draft) => {
      draft.subagent = { callId, durable: [], live: [] };
    });
    await this.sendWatch(callId, 0);
  }

  /** Drop the watch; the server keeps it until the socket closes or a re-attach. */
  public unwatch(): void {
    // Untracked: callers include effect callbacks, and this reads a snapshot.
    const callId = untrack(() => this.state.subagent?.callId);
    if (callId === undefined) {
      return;
    }
    this.setState((draft) => {
      draft.subagent = undefined;
    });
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
    return rankCommands(
      query,
      [...LOCAL_COMMANDS, ...(response?.items ?? [])],
      {
        limit,
      }
    );
  }

  /** What is inside a directory on the server; throws what it refused with. */
  public async listDirectory(path: string): Promise<DirectoryListing> {
    const response = await this.client.send({ type: "list_dirs", path });
    if (!response.success || !response.directory) {
      throw new Error(response.error ?? `could not read ${path}`);
    }
    return response.directory;
  }

  /** The cwd's branches, in the order the server ranks them. */
  public async listBranches(): Promise<readonly GitBranch[]> {
    const response = await this.client.send({
      type: "list_branches",
      sessionId: this.attached(),
    });
    if (!response.success || !response.branches) {
      throw new Error(response.error ?? "could not read the branches");
    }
    return response.branches;
  }

  /** Every changed file of one diff base, carrying no hunks. */
  public async listChanges(base: DiffBase): Promise<ChangeList> {
    const response = await this.client.send({
      type: "list_changes",
      sessionId: this.attached(),
      base,
    });
    if (!response.success || !response.changes) {
      throw new Error(response.error ?? "could not read the changes");
    }
    return response.changes;
  }

  /** One file's hunks, asked for only once a reader expands it. */
  public async fileDiff(path: string, base: DiffBase): Promise<FileDiff> {
    const response = await this.client.send({
      type: "file_diff",
      sessionId: this.attached(),
      base,
      path,
    });
    if (!response.success || !response.fileDiff) {
      throw new Error(response.error ?? `could not diff ${path}`);
    }
    return response.fileDiff;
  }

  /** The file's own lines behind a gap, asked for only once a reader opens one. */
  public async readLines(
    path: string,
    base: DiffBase,
    spans: readonly LineSpan[]
  ): Promise<FileLines> {
    const response = await this.client.send({
      type: "read_lines",
      sessionId: this.attached(),
      base,
      path,
      spans,
    });
    if (!response.success || !response.fileLines) {
      throw new Error(response.error ?? `could not read ${path}`);
    }
    return response.fileLines;
  }

  /** Stages and commits exactly these paths; answers the short sha git wrote. */
  public async commit(
    message: string,
    paths: readonly string[]
  ): Promise<string> {
    const response = await this.client.send({
      type: "commit",
      sessionId: this.attached(),
      message,
      paths,
    });
    if (!response.success || !response.commit) {
      throw new Error(response.error ?? "git refused the commit");
    }
    return response.commit.sha;
  }

  /**
   * Re-reads the repository for a picture that may have aged — the tab coming
   * back, a menu opening. `fetch` asks the remote first, which is the only
   * thing that moves ahead and behind.
   */
  public async refreshGit(fetch = false): Promise<void> {
    const sessionId = this.attached();
    if (sessionId === "") {
      return;
    }
    await this.client
      .send({
        type: "refresh_git",
        sessionId,
        fetch,
      })
      .catch(() => undefined);
  }

  public checkout(branch: string): Promise<void> {
    return this.runGit({
      type: "checkout",
      sessionId: this.attached(),
      branch,
    });
  }

  public pull(): Promise<void> {
    return this.runGit({ type: "pull", sessionId: this.attached() });
  }

  public push(): Promise<void> {
    return this.runGit({ type: "push", sessionId: this.attached() });
  }

  /** Which session a command is about to name: a snapshot, never a dependency of whoever asked. */
  private attached(): string {
    return untrack(() => this.state.sessionId);
  }

  private async runGit(draft: CommandDraft): Promise<void> {
    const response = await this.client.send(draft);
    if (!response.success) {
      throw new Error(response.error ?? "git refused the operation");
    }
  }

  /** Directories this machine has sessions in, recent first, current one left out. */
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
    this.setState((draft) => {
      for (const session of sessions) {
        draft.activity[session.sessionId] = session.status ?? "idle";
        draft.unread[session.sessionId] = session.unread ?? false;
        if (session.title !== undefined) {
          delete draft.openings[session.sessionId];
        }
      }
    });
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

  /** The files waiting to go with a session's unsent message. */
  public attachmentsOf(sessionId: string): readonly UploadedAttachment[] {
    return this.state.attachments[sessionId] ?? [];
  }

  /** Uploads the bytes, filed under the session current when the upload began. */
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
   * thinks at, cached for the connection's lifetime.
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
    if (this.isHeld()) {
      return;
    }
    await this.client
      .send({ type, sessionId: this.state.sessionId, value })
      .catch(() => undefined);
  }

  public async switchTo(sessionId: string): Promise<void> {
    // Re-attaching replays from seq 0 onto a transcript this client keeps, doubling it.
    if (sessionId === this.state.sessionId) {
      return;
    }
    await this.attach({ sessionId });
  }

  /** Open a new chat, or return to the unwritten one already open. */
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

  /** Work somewhere else, always in a new session: pi logs under the cwd. */
  public async openDirectory(cwd: string): Promise<void> {
    const unwritten = this.state.unwritten;
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

  private async restart(
    unwritten: Unwritten,
    cwd = unwritten.cwd
  ): Promise<void> {
    const typed = this.drafts.takeDraft(unwritten.sessionId);
    try {
      await this.startDraft(typed, cwd);
    } catch (error) {
      this.drafts.putDraft(unwritten.sessionId, typed);
      throw error;
    }
  }

  /** Send `cwd` as well as `like`: a restarted server cannot honour `like`. */
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
      this.setState((draft) => {
        draft.loading = false;
        draft.error = (error as Error).message;
      });
      throw error;
    }
  }

  /** What this browser resolves the gateway's own paths against: its uploads, and the pictures a tool view names. */
  public get httpUrl(): string {
    return this.client.httpUrl;
  }

  private absolute(url: string): string {
    return url.startsWith("/") ? `${this.httpUrl}${url}` : url;
  }

  private readonly toAbsolute = (url: string): string => this.absolute(url);

  public ingest(frame: ServerEvent): void {
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
          // A different session invalidates this client's ordinals; the same one resumes.
          if (draft.sessionId !== event.sessionId) {
            draft.durable = [];
            draft.optimistic = [];
            draft.agent = draft.activity[event.sessionId] ?? "idle";
            draft.writable = true;
            draft.heldBy = undefined;
            draft.turnElapsedMs = undefined;
            draft.loading = event.head > 0;
          }
          draft.sessionId = event.sessionId;
          draft.cwd = event.cwd;
          draft.pimVersion = event.pimVersion;
          draft.piVersion = event.piVersion;
          // The server re-sends the whole in-flight turn on attach; keeping live doubles it.
          draft.live = [];
          draft.error = undefined;
        });
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
      case "sessions_changed":
        this.setState((draft) => {
          draft.catalogue += 1;
        });
        return;
      case "session_state":
        this.setState((draft) => {
          // Last event of a replay, so the log is complete.
          draft.loading = false;
          draft.cwd = event.cwd;
          draft.model = event.model;
          draft.modelLabel = event.modelLabel ?? event.model;
          draft.thinking = event.thinking;
          draft.cost = event.cost;
          draft.agent = event.status;
          draft.writable = event.writable;
          draft.repoBusy = event.repoBusy === true;
          draft.heldBy = event.heldBy;
          draft.turnElapsedMs = event.turnElapsedMs;
          draft.activity[draft.sessionId] = event.status;
          draft.contextPercent = event.contextPercent;
          draft.contextWindow = event.contextWindow;
          draft.branch = event.branch;
          draft.dirtyCount = event.dirtyCount ?? 0;
          draft.ahead = event.ahead ?? 0;
          draft.behind = event.behind ?? 0;
          // The server says idle only after flushing the turn's entries; live is superseded.
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

  private dropQueued(): void {
    this.setState((draft) => {
      draft.optimistic = draft.optimistic.filter((pending) => !pending.queued);
    });
  }
}
