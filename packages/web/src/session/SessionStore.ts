import { createStore, untrack, type Store, type StoreSetter } from "solid-js";

import type { PickerItem } from "#core/picker/PickerItem";
import { rankCommands } from "#core/picker/commandRanker";
import { RemoteFilePickerSuggestionEngine } from "#core/picker/RemoteFilePickerSuggestionEngine";
import type { DirectoryListing } from "#core/shared/Directories";
import type { GitBranch } from "#core/shared/Git";
import type { ExtensionEntry } from "#core/shared/PiExtensions";
import type { NoticeSeverity } from "#core/view/ViewBlock";
import type {
  AttachmentRef,
  CommandDraft,
  SearchScope,
  SessionScope,
} from "#protocol/Command";
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
  ResponseEvent,
  SessionListing,
  SessionSearch,
  ServerEvent,
  SessionStatus,
} from "#protocol/ServerEvent";
import { isDurableEvent } from "#protocol/ServerEvent";
import { watchAttention } from "../ws/attention";
import { watchWake } from "../ws/wake";
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

export type { LiveMessage, PendingMessage } from "./fold";

export type ModelCatalogue = {
  readonly models: readonly ModelView[];
  readonly thinkingLevels: readonly string[];
};

export type LeaseHolder = Extract<
  EphemeralEvent,
  { readonly type: "session_state" }
>["heldBy"];

/** A file the server holds for the next message. */
export type UploadedAttachment = {
  readonly id: string;
  readonly url: string;
  readonly isImage: boolean;
  readonly name: string;
};

/** Markdown from an extension. */
export type UiNotice = {
  readonly id: string;
  readonly severity: NoticeSeverity;
  readonly text: string;
  /** The command that produced it, like `/login`. Absent for unprompted notices. */
  readonly command?: string;
};

export type UiRequest = Extract<
  EphemeralEvent,
  { readonly type: "ui_request" }
>;

/** A dismissal is `cancelled`. */
export type UiAnswer = Omit<
  Extract<CommandDraft, { readonly type: "ui_response" }>,
  "type" | "sessionId" | "requestId"
>;

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
  /** False while another process holds the turn lease. */
  writable: boolean;
  /** A session in the same directory is mid-turn, so git operations must wait. */
  repoBusy: boolean;
  heldBy: LeaseHolder;
  turnElapsedMs: number | undefined;
  contextPercent: number | undefined;
  contextWindow: number | undefined;
  branch: string | undefined;
  dirtyCount: number;
  ahead: number;
  behind: number;
  /** Changes whenever the working copy does. */
  repoRevision: string;
  durable: DurableEvent[];
  live: LiveMessage[];
  optimistic: OptimisticMessage[];
  activity: Record<string, SessionStatus>;
  /** Bumped when sessions on disk change. */
  catalogue: number;
  /** Bumped when any window toggles an extension. */
  extensions: number;
  loading: boolean;
  error: string | undefined;
  unread: Record<string, boolean>;
  archived: Record<string, boolean>;
  /** `null` once cleared; absent when unknown. */
  names: Record<string, string | null>;
  /** Keyed by cwd. */
  pinned: Record<string, boolean>;
  /** Keyed by cwd, 0 first. */
  pinRank: Record<string, number>;
  /** Keyed by cwd. */
  expanded: Record<string, boolean>;
  /** Keyed by cwd; `null` once cleared. */
  labels: Record<string, string | null>;
  drafts: Record<string, string>;
  attachments: Record<string, readonly UploadedAttachment[]>;
  openings: Record<string, string>;
  unwritten: Unwritten | undefined;
  subagent: SubagentTranscript | undefined;
  /** Notices from a command this client ran; shown in the modal. */
  notices: UiNotice[];
  /** Unprompted notices; shown as toasts. */
  toasts: UiNotice[];
  /** Open dialogs, oldest first. */
  requests: UiRequest[];
};

/** One send's contribution to an optimistic row, which may also hold other merged sends. */
type Undo = {
  readonly id: string;
  readonly text: string;
  readonly attachments: readonly AttachmentView[];
  /** The session whose opening message this send set. */
  readonly opened: string | undefined;
};

export type SessionStoreOptions = {
  readonly url: string;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly retryMs?: number;
  readonly pickerDebounceMs?: number;
  readonly reloadPage?: () => void;
};

type FlagRecord = "archived" | "unread" | "pinned" | "expanded";

const FILE_PICKER_LIMIT = 50;
const COMMAND_PICKER_LIMIT = 20;

/** Removes one `"\n\n"`-joined `segment` from `text`; returns `text` unchanged if absent. */
function withoutSegment(text: string, segment: string): string {
  if (text === segment) {
    return "";
  }
  if (text.startsWith(`${segment}\n\n`)) {
    return text.slice(segment.length + 2);
  }
  if (text.endsWith(`\n\n${segment}`)) {
    return text.slice(0, -segment.length - 2);
  }
  const inside = text.indexOf(`\n\n${segment}\n\n`);
  return inside === -1
    ? text
    : text.slice(0, inside) + text.slice(inside + segment.length + 2);
}

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

/** Client state for one session; the only place an intent becomes a command. */
export class SessionStore {
  public readonly client: WsClient;
  public readonly update: Reload;
  public readonly files: RemoteFilePickerSuggestionEngine;
  public readonly state: Store<SessionState>;
  private readonly setState: StoreSetter<SessionState>;
  private optimisticId = 0;
  private catalogue: Promise<ModelCatalogue> | undefined;
  private roster: Promise<readonly ExtensionEntry[]> | undefined;
  private readonly drafts: Drafts;
  private readonly detachAttention: () => void;
  private readonly detachWake: () => void;
  /** `record:key` of optimistic writes still awaiting an answer; listings must not overwrite them. */
  private readonly guessed = new Set<string>();

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
      repoRevision: "",
      durable: [],
      live: [],
      optimistic: [],
      activity: {},
      catalogue: 0,
      extensions: 0,
      loading: false,
      error: undefined,
      unread: {},
      archived: {},
      names: {},
      pinned: {},
      pinRank: {},
      expanded: {},
      labels: {},
      drafts: { ...drafts },
      attachments: {},
      openings: {},
      unwritten,
      subagent: undefined,
      notices: [],
      toasts: [],
      requests: [],
    });
    this.state = state;
    this.setState = setState;
    this.drafts = new Drafts(state, setState, drafts);
    this.drafts.claimed = sessionId === undefined ? "" : undefined;
    this.client = new WsClient({
      url: options.url,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(options.retryMs === undefined ? {} : { retryMs: options.retryMs }),
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
    this.detachAttention = watchAttention((value) => {
      this.client.setAttention(value);
    });
    this.detachWake = watchWake(() => {
      this.client.wake();
    });
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
    this.detachAttention();
    this.detachWake();
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

  /** Sent messages not yet echoed back. */
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

  private isHeld(): boolean {
    return !this.state.writable;
  }

  /** Composer text while another surface holds the turn. */
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

  public isRunning(sessionId: string): boolean {
    return (this.state.activity[sessionId] ?? "idle") !== "idle";
  }

  /** Sorted, so it is stable as a dependency. */
  public runningIds(): readonly string[] {
    return Object.keys(this.state.activity)
      .filter((sessionId) => this.isRunning(sessionId))
      .sort();
  }

  /**
   * Sends a message; during a running turn it merges into the queued row.
   * Returns false if nothing was sent, so the caller keeps its input.
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
    if (this.isHeld()) {
      return false;
    }
    const carried: readonly AttachmentView[] = attachments.map(
      ({ name, url, isImage }) => ({ name, url, isImage })
    );
    const busy = this.isBusy();
    // Read inside the write so two sends in one tick see each other.
    let rowId = "";
    let opened: string | undefined;
    this.setState((draft) => {
      const opens =
        openingMessage(draft.durable, draft.optimistic) === undefined;
      const growing = busy
        ? draft.optimistic.find((pending) => pending.queued)
        : undefined;
      if (growing) {
        rowId = growing.id;
        growing.text = `${growing.text}\n\n${trimmed}`;
        growing.attachments = [...(growing.attachments ?? []), ...carried];
      } else {
        rowId = `optimistic:${++this.optimisticId}`;
        draft.optimistic.push({
          id: rowId,
          text: trimmed,
          ...(carried.length === 0 ? {} : { attachments: carried }),
          timestamp: Date.now(),
          ...(busy ? { queued: true } : {}),
        });
      }
      if (opens) {
        draft.openings[draft.sessionId] = trimmed;
        opened = draft.sessionId;
      }
      draft.error = undefined;
    });
    const undo: Undo = {
      id: rowId,
      text: trimmed,
      attachments: carried,
      opened,
    };
    this.drafts.spendDraft();
    const refs: readonly AttachmentRef[] = attachments.map(({ id: ref }) => ({
      id: ref,
    }));
    let response: ResponseEvent;
    try {
      response = await this.client.send({
        type: "user_message",
        sessionId,
        text: trimmed,
        ...(refs.length === 0 ? {} : { attachments: refs }),
      });
      if (!response.success) {
        throw new Error(response.error ?? "the server refused the message");
      }
    } catch (err) {
      this.rollback(undo);
      this.setState((draft) => {
        draft.error = (err as Error).message;
      });
      return false;
    }
    // An extension command writes no entry, so nothing will replace the row.
    if (response.dispatched === true) {
      this.rollback(undo);
    }
    return true;
  }

  /** Stops the turn; resolves to the queued text that was never sent. */
  public cancel(): Promise<string> {
    return this.reclaim({ type: "cancel", sessionId: this.state.sessionId });
  }

  /** Takes the queued text back for editing; the turn keeps running. */
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

  /** Removes the dialog immediately rather than waiting for `ui_request_done`. */
  public answerRequest(requestId: string, answer: UiAnswer): void {
    // Read inside the write so a double press answers once.
    let asked = false;
    this.setState((draft) => {
      asked = draft.requests.some((request) => request.requestId === requestId);
      draft.requests = draft.requests.filter(
        (request) => request.requestId !== requestId
      );
    });
    if (!asked) {
      return;
    }
    this.sendAnswer(requestId, answer);
  }

  /** Closes the modal, cancelling every open dialog. */
  public closeCommand(): void {
    let shown: readonly string[] = [];
    this.setState((draft) => {
      shown = draft.requests.map((request) => request.requestId);
      draft.requests = [];
      draft.notices = [];
    });
    for (const requestId of shown) {
      this.sendAnswer(requestId, { cancelled: true });
    }
  }

  /** A refusal means another window answered first, so it is ignored. */
  private sendAnswer(requestId: string, answer: UiAnswer): void {
    void this.client
      .send({
        type: "ui_response",
        sessionId: this.attached(),
        requestId,
        ...answer,
      })
      .catch(() => undefined);
  }

  public dismissToast(id: string): void {
    this.setState((draft) => {
      draft.toasts = draft.toasts.filter((notice) => notice.id !== id);
    });
  }

  public async watch(callId: string): Promise<void> {
    this.setState((draft) => {
      draft.subagent = { callId, durable: [], live: [] };
    });
    await this.sendWatch(callId, 0);
  }

  public unwatch(): void {
    // Untracked: effects call this.
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

  public async listDirectory(path: string): Promise<DirectoryListing> {
    const response = await this.client.send({ type: "list_dirs", path });
    if (!response.success || !response.directory) {
      throw new Error(response.error ?? `could not read ${path}`);
    }
    return response.directory;
  }

  public async createDirectory(path: string): Promise<void> {
    const response = await this.client.send({ type: "create_dir", path });
    if (!response.success) {
      throw new Error(response.error ?? `could not create ${path}`);
    }
  }

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

  /** Changed files without hunks; see `fileDiff`. */
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

  /** Stages and commits exactly `paths`; resolves to the short sha. */
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

  /** `fetch` also fetches the remote, which is what updates ahead/behind. */
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

  /** Untracked, so callers do not subscribe to the session id. */
  private attached(): string {
    return untrack(() => this.state.sessionId);
  }

  private runGit(draft: CommandDraft): Promise<void> {
    return this.demand(draft, "git refused the operation");
  }

  /** Sends and throws if the server refuses. */
  private async demand(draft: CommandDraft, refusal: string): Promise<void> {
    const response = await this.client.send(draft);
    if (!response.success) {
      throw new Error(response.error ?? refusal);
    }
  }

  public async listSessions(scope: SessionScope = {}): Promise<SessionListing> {
    const response = await this.client
      .send({
        type: "list_sessions",
        ...(scope.cwd === undefined ? {} : { cwd: scope.cwd }),
        ...(scope.perProject === undefined
          ? {}
          : { perProject: scope.perProject }),
        ...(scope.limit === undefined ? {} : { limit: scope.limit }),
        ...(scope.archived === true ? { archived: true } : {}),
      })
      .catch(() => undefined);
    const sessions = response?.sessions ?? [];
    this.setState((draft) => {
      for (const session of sessions) {
        draft.activity[session.sessionId] = session.status ?? "idle";
        this.seed(draft, "unread", session.sessionId, session.unread ?? false);
        this.seed(
          draft,
          "archived",
          session.sessionId,
          session.archived === true
        );
        if (!this.guessed.has(`names:${session.sessionId}`)) {
          draft.names[session.sessionId] =
            session.named === true ? (session.title ?? null) : null;
        }
        if (session.title !== undefined) {
          delete draft.openings[session.sessionId];
        }
      }
      for (const project of response?.projects ?? []) {
        this.seed(draft, "pinned", project.cwd, project.pinned === true);
        this.seed(draft, "expanded", project.cwd, project.expanded === true);
        if (!this.guessed.has(`labels:${project.cwd}`)) {
          draft.labels[project.cwd] = project.label ?? null;
        }
        // A rank belongs to the pin's guess.
        if (!this.guessed.has(`pinned:${project.cwd}`)) {
          if (project.pinRank === undefined) {
            delete draft.pinRank[project.cwd];
          } else {
            draft.pinRank[project.cwd] = project.pinRank;
          }
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
    return { sessions, projects: response?.projects ?? [] };
  }

  private seed(
    state: SessionState,
    record: FlagRecord,
    key: string,
    value: boolean
  ): void {
    if (!this.guessed.has(`${record}:${key}`)) {
      state[record][key] = value;
    }
  }

  /**
   * Searches every session on disk. An empty `query` warms the index and
   * returns only `scanned`. Throws on failure, unlike `listSessions`.
   */
  public async searchSessions(
    query: string,
    scope: SearchScope = {}
  ): Promise<SessionSearch> {
    const response = await this.client.send({
      type: "search_sessions",
      query,
      ...(scope.cwd === undefined ? {} : { cwd: scope.cwd }),
      ...(scope.archived === undefined ? {} : { archived: scope.archived }),
      ...(scope.limit === undefined ? {} : { limit: scope.limit }),
    });
    if (!response.success) {
      throw new Error(response.error ?? "the search was refused");
    }
    return {
      hits: response.hits ?? [],
      dropped: response.dropped ?? [],
      scanned: response.scanned ?? 0,
    };
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

  public attachmentsOf(sessionId: string): readonly UploadedAttachment[] {
    return this.state.attachments[sessionId] ?? [];
  }

  /** Files the upload under the session current when it started. */
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

  /** The upload stays on the server. */
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

  /** Cached until a request fails. */
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

  /** Cached until `extensions_changed` or a failure. */
  public listExtensions(): Promise<readonly ExtensionEntry[]> {
    this.roster ??= this.client
      .send({ type: "list_extensions" })
      .then((response) => {
        if (!response.success) {
          throw new Error(response.error ?? "could not read the extensions");
        }
        return response.extensions ?? [];
      })
      .catch((error: Error) => {
        this.roster = undefined;
        throw error;
      });
    return this.roster;
  }

  /** The cached roster is dropped on the `extensions_changed` broadcast, not here. */
  public setExtension(id: string, value: boolean): Promise<void> {
    return this.demand(
      { type: "set_extension", extensionId: id, value },
      "the server refused the change"
    );
  }

  public isUnread(sessionId: string): boolean {
    return this.state.unread[sessionId] ?? false;
  }

  public isArchived(sessionId: string): boolean {
    return this.state.archived[sessionId] ?? false;
  }

  public isPinned(cwd: string): boolean {
    return this.state.pinned[cwd] ?? false;
  }

  /** Pinned cwds in display order; a pin without a rank sorts last. */
  public pinOrder(): readonly string[] {
    return Object.keys(this.state.pinned)
      .filter((cwd) => this.isPinned(cwd))
      .sort((one, other) => this.pinRankOf(one) - this.pinRankOf(other));
  }

  public pinRankOf(cwd: string): number {
    return this.state.pinRank[cwd] ?? Number.MAX_SAFE_INTEGER;
  }

  public isExpanded(cwd: string): boolean {
    return this.state.expanded[cwd] ?? false;
  }

  public projectLabel(cwd: string): string | undefined {
    return this.state.labels[cwd] ?? undefined;
  }

  /** `null` reverts to the directory's base name. */
  public renameProject(cwd: string, name: string | null): Promise<void> {
    return this.guessName(
      "labels",
      cwd,
      name,
      { type: "set_project_label", cwd, value: name },
      "the server refused the name"
    );
  }

  public setExpanded(cwd: string, value: boolean): Promise<void> {
    return this.flag(
      { type: "set_project_expanded", cwd, value },
      "expanded",
      cwd,
      value,
      "the server refused the fold"
    );
  }

  public sessionName(sessionId: string): string | undefined {
    return this.state.names[sessionId] ?? undefined;
  }

  /** Sets pi's session name; `null` clears it. */
  public rename(sessionId: string, name: string | null): Promise<void> {
    return this.guessName(
      "names",
      sessionId,
      name,
      { type: "set_session_name", sessionId, value: name },
      "the server refused the name"
    );
  }

  public setArchived(sessionId: string, value: boolean): Promise<void> {
    return this.flag(
      { type: "set_session_archived", sessionId, value },
      "archived",
      sessionId,
      value,
      "the server refused the change"
    );
  }

  public markUnread(sessionId: string, value: boolean): Promise<void> {
    return this.flag(
      { type: "set_session_unread", sessionId, value },
      "unread",
      sessionId,
      value,
      "the server refused the mark"
    );
  }

  public setPinned(cwd: string, value: boolean): Promise<void> {
    return this.flag(
      { type: "set_project_pinned", cwd, value },
      "pinned",
      cwd,
      value,
      "the server refused the pin"
    );
  }

  /**
   * Swaps a pinned project with its neighbour. The order may include projects
   * not on this page, so a press can appear to do nothing.
   */
  public async movePin(cwd: string, delta: -1 | 1): Promise<void> {
    const order = [...this.pinOrder()];
    const at = order.indexOf(cwd);
    const to = at + delta;
    const moved = order[at];
    const displaced = order[to];
    if (moved === undefined || displaced === undefined) {
      return;
    }
    order[at] = displaced;
    order[to] = moved;
    const before = { ...this.state.pinRank };
    this.setState((draft) => {
      draft.pinRank[moved] = to;
      draft.pinRank[displaced] = at;
    });
    try {
      await this.demand(
        { type: "set_pin_order", order },
        "the server refused the order"
      );
    } catch (error) {
      this.setState((draft) => {
        draft.pinRank = before;
      });
      throw error;
    }
  }

  private async flag(
    draft: CommandDraft,
    record: FlagRecord,
    key: string,
    value: boolean,
    refusal: string
  ): Promise<void> {
    const before = untrack(() => this.state[record][key]);
    await this.guess(
      `${record}:${key}`,
      (state) => {
        state[record][key] = value;
      },
      (state) => {
        state[record][key] = before ?? false;
      },
      draft,
      refusal
    );
  }

  private async guessName(
    record: "names" | "labels",
    key: string,
    value: string | null,
    draft: CommandDraft,
    refusal: string
  ): Promise<void> {
    const before = untrack(() => this.state[record][key]);
    await this.guess(
      `${record}:${key}`,
      (state) => {
        state[record][key] = value;
      },
      (state) => {
        if (before === undefined) {
          delete state[record][key];
        } else {
          state[record][key] = before;
        }
      },
      draft,
      refusal
    );
  }

  /** Applies optimistically, restoring on refusal; `key` shields it from listings meanwhile. */
  private async guess(
    key: string,
    apply: (state: SessionState) => void,
    restore: (state: SessionState) => void,
    draft: CommandDraft,
    refusal: string
  ): Promise<void> {
    this.guessed.add(key);
    this.setState(apply);
    try {
      await this.demand(draft, refusal);
    } catch (error) {
      this.setState(restore);
      throw error;
    } finally {
      this.guessed.delete(key);
    }
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
    // Re-attaching would replay onto the kept transcript and double it.
    if (sessionId === this.state.sessionId) {
      return;
    }
    await this.attach({ sessionId });
  }

  /** Reuses the open unwritten session if there is one. */
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

  /** Always a new session, since pi stores sessions per cwd. */
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

  /** Sends `cwd` too, since a restarted server cannot resolve `like`. */
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

  public get httpUrl(): string {
    return this.client.httpUrl;
  }

  private readonly absolute = (url: string): string =>
    url.startsWith("/") ? `${this.httpUrl}${url}` : url;

  public ingest(frame: ServerEvent): void {
    const event = resolveUrls(frame, this.absolute);
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
          // The same session resumes; a different one starts over.
          if (draft.sessionId !== event.sessionId) {
            draft.durable = [];
            draft.optimistic = [];
            draft.agent = draft.activity[event.sessionId] ?? "idle";
            draft.writable = true;
            draft.heldBy = undefined;
            draft.turnElapsedMs = undefined;
            draft.loading = event.head > 0;
          }
          // The replay re-sends any dialog still open.
          draft.notices = [];
          draft.toasts = [];
          draft.requests = [];
          draft.sessionId = event.sessionId;
          draft.cwd = event.cwd;
          draft.pimVersion = event.pimVersion;
          draft.piVersion = event.piVersion;
          // The server re-sends the in-flight turn on attach.
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
            applyChild(watched, resolveUrls(inner, this.absolute));
          }
        });
        return;
      case "picker_invalidate":
        void this.files.refreshRelative();
        return;
      case "ui_notice":
        this.setState((draft) => {
          const notice = {
            id: event.id,
            severity: event.severity,
            text: event.text,
            ...(event.command === undefined ? {} : { command: event.command }),
          };
          if (notice.command === undefined) {
            draft.toasts.push(notice);
          } else {
            draft.notices.push(notice);
          }
        });
        return;
      case "ui_request":
        this.setState((draft) => {
          draft.requests.push(event);
        });
        return;
      case "ui_request_done":
        this.setState((draft) => {
          draft.requests = draft.requests.filter(
            (request) => request.requestId !== event.requestId
          );
        });
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
      case "session_meta":
        this.setState((draft) => {
          if (event.name !== undefined) {
            draft.names[event.sessionId] = event.name;
          }
          if (event.archived !== undefined) {
            draft.archived[event.sessionId] = event.archived;
          }
          if (event.unread !== undefined) {
            draft.unread[event.sessionId] = event.unread;
          }
        });
        return;
      case "project_meta":
        this.setState((draft) => {
          if (event.pinned !== undefined) {
            draft.pinned[event.cwd] = event.pinned;
          }
          if (event.expanded !== undefined) {
            draft.expanded[event.cwd] = event.expanded;
          }
          if (event.label !== undefined) {
            draft.labels[event.cwd] = event.label;
          }
        });
        return;
      case "pins_changed":
        this.setState((draft) => {
          draft.pinRank = Object.fromEntries(
            event.order.map((cwd, rank) => [cwd, rank])
          );
        });
        return;
      case "sessions_changed":
        this.setState((draft) => {
          draft.catalogue += 1;
        });
        return;
      case "extensions_changed":
        this.roster = undefined;
        this.setState((draft) => {
          draft.extensions += 1;
        });
        return;
      case "session_state":
        this.setState((draft) => {
          // Last event of a replay.
          draft.loading = false;
          draft.cwd = event.cwd;
          draft.model = event.model;
          draft.modelLabel = event.modelLabel ?? event.model;
          draft.thinking = event.thinking;
          draft.cost = event.cost;
          const settled = draft.agent !== "idle" && event.status === "idle";
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
          draft.repoRevision = event.repoRevision ?? "";
          // Idle arrives after the turn's durable entries, which supersede live.
          if (event.status === "idle") {
            draft.live = [];
          }
          // A send whose durable text never matched (an expanded template) would otherwise linger.
          if (settled) {
            draft.optimistic = draft.optimistic.filter(
              (pending) => pending.queued
            );
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

  /** Removes one send from its optimistic row, and the row once empty. */
  private rollback(undo: Undo): void {
    this.setState((draft) => {
      if (undo.opened !== undefined) {
        delete draft.openings[undo.opened];
      }
      const row = draft.optimistic.find((pending) => pending.id === undo.id);
      if (row === undefined) {
        return;
      }
      const left = withoutSegment(row.text, undo.text);
      if (left === "") {
        draft.optimistic = draft.optimistic.filter(
          (pending) => pending.id !== undo.id
        );
        return;
      }
      row.text = left;
      const mine = new Set(undo.attachments.map((carried) => carried.url));
      const kept = (row.attachments ?? []).filter(
        (held) => !mine.has(held.url)
      );
      if (kept.length === 0) {
        delete row.attachments;
      } else {
        row.attachments = kept;
      }
    });
  }

  private dropQueued(): void {
    this.setState((draft) => {
      draft.optimistic = draft.optimistic.filter((pending) => !pending.queued);
    });
  }
}
