import { createStore, untrack, type Store, type StoreSetter } from "solid-js";

import type { PickerItem } from "#core/picker/PickerItem";
import { rankCommands } from "#core/picker/commandRanker";
import { RemoteFilePickerSuggestionEngine } from "#core/picker/RemoteFilePickerSuggestionEngine";
import type { DirectoryListing } from "#core/shared/Directories";
import type { GitBranch } from "#core/shared/Git";
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

/** Something an extension said, in Markdown; shown and then forgotten. */
export type UiNotice = {
  readonly id: string;
  readonly severity: NoticeSeverity;
  readonly text: string;
  /** The command that said it, like `/login`; absent means nobody asked for it. */
  readonly command?: string;
};

/** The dialog an extension is waiting on a human for. */
export type UiRequest = Extract<
  EphemeralEvent,
  { readonly type: "ui_request" }
>;

/** What goes back for a `UiRequest`; a dismissal is `cancelled`. */
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
  /** Changes whenever the working copy does; what the change list re-reads on. */
  repoRevision: string;
  durable: DurableEvent[];
  live: LiveMessage[];
  optimistic: OptimisticMessage[];
  activity: Record<string, SessionStatus>;
  /** Bumped whenever the server says the sessions on disk moved; a listing read before it is stale. */
  catalogue: number;
  loading: boolean;
  error: string | undefined;
  unread: Record<string, boolean>;
  /** Out of the default listing until it is brought back; keyed by session. */
  archived: Record<string, boolean>;
  /** The name somebody wrote for a session, `null` once cleared; absent where this client has heard nothing. */
  names: Record<string, string | null>;
  /** Pinned projects, keyed by absolute working directory rather than by session. */
  pinned: Record<string, boolean>;
  /** Where each pinned project sorts, 0 first; the server owns it, so a directory it has nothing for is absent. */
  pinRank: Record<string, number>;
  /** Projects whose sidebar group stands unfolded, keyed by absolute working directory. */
  expanded: Record<string, boolean>;
  /** What a project is called instead of its base name, `null` once cleared; keyed by absolute working directory. */
  labels: Record<string, string | null>;
  drafts: Record<string, string>;
  attachments: Record<string, readonly UploadedAttachment[]>;
  openings: Record<string, string>;
  unwritten: Unwritten | undefined;
  subagent: SubagentTranscript | undefined;
  /** What a command this reader typed said back, stacked into one modal until it is closed. */
  notices: UiNotice[];
  /** What an extension said with nobody waiting on it: a toast each, never the modal. */
  toasts: UiNotice[];
  /** The dialogs waiting on this reader, asked in the order they were raised; extensions nest them. */
  requests: UiRequest[];
};

/**
 * What one send drew into a row, so a send that never landed can be taken
 * back out of it. Not the row as a whole: a send into a running turn merges
 * into the queued row, so by the time the answer comes the row may be
 * standing for somebody else's words too.
 */
type Undo = {
  readonly id: string;
  readonly text: string;
  readonly attachments: readonly AttachmentView[];
  /** The session this send guessed the opening message of. */
  readonly opened: string | undefined;
};

export type SessionStoreOptions = {
  readonly url: string;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly backoffMs?: (attempt: number) => number;
  readonly pickerDebounceMs?: number;
  readonly reloadPage?: () => void;
};

/** The flags a row or a group draws from this store alone, each one a command away. */
type FlagRecord = "archived" | "unread" | "pinned" | "expanded";

const FILE_PICKER_LIMIT = 50;
const COMMAND_PICKER_LIMIT = 20;

/**
 * The inverse of the `"\n\n"` merge into a queued row: `text` without the one
 * `segment` a send put there, or `text` itself where it is no longer in it.
 */
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
  private readonly detachAttention: () => void;
  /**
   * Keys a command of this client's still has a guess standing in for, as
   * `record:key`. A listing the server computed before the command reached it
   * would otherwise paint the row back the way it was, one frame before the
   * broadcast puts it right again.
   */
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
    this.detachAttention = watchAttention((value) => {
      this.client.setAttention(value);
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
    // An extension command took no turn and wrote no entry, so nothing will
    // ever arrive to reconcile the row this drew.
    if (response.dispatched === true) {
      this.rollback(undo);
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

  /**
   * Answers one named dialog — the one the press was aimed at, which is not
   * always the only one waiting. The request leaves here rather than on the
   * `ui_request_done` that follows, so the control goes with the press; a
   * refusal only ever means another window answered first.
   */
  public answerRequest(requestId: string, answer: UiAnswer): void {
    // Read inside the write: state settles later, so two presses in one tick
    // would both find the dialog still standing.
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

  /** Escape, the backdrop and the back gesture all land here, and a dialog left unanswered is a cancelled one. */
  public closeCommand(): void {
    // One panel, so one dismissal: a question waiting behind the one on
    // screen goes off with it rather than being left for a ceiling to answer.
    // One write for the lot: each would otherwise re-run the modal's memos.
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

  /** A refusal here only ever means another window answered first, so it is dropped. */
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

  /** Makes a directory on the server; throws what it refused with. */
  public async createDirectory(path: string): Promise<void> {
    const response = await this.client.send({ type: "create_dir", path });
    if (!response.success) {
      throw new Error(response.error ?? `could not create ${path}`);
    }
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

  private runGit(draft: CommandDraft): Promise<void> {
    return this.demand(draft, "git refused the operation");
  }

  /** Sends, and raises what the server refused with, so a caller can say so. */
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
      // A pin belongs to a directory, and every row's directory is in here:
      // the projects are counted off the same scope the page is cut from.
      for (const project of response?.projects ?? []) {
        this.seed(draft, "pinned", project.cwd, project.pinned === true);
        this.seed(draft, "expanded", project.cwd, project.expanded === true);
        if (!this.guessed.has(`labels:${project.cwd}`)) {
          draft.labels[project.cwd] = project.label ?? null;
        }
        // Under the pin's own key: a rank is half of the same guess, and a
        // listing computed before the pin reached the server carries neither.
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
    // The server's rows, unfolded: every flag on one is held in this store and
    // read back through it, so a snapshot taken here would only go stale.
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
   * Ranked search over every session on disk, titles and what was said, which
   * is the only honest one: a page of the sidebar is a fraction of the tree.
   * An empty `query` is the warm call — it builds the index, answers no hits,
   * and counts the whole scope, which is the number the empty state prints.
   * Raises where a listing swallows: a listing that fails draws no rows and
   * looks empty, which is nearly true, but a search that fails still owes the
   * reader a scope, and `scanned: 0` would have it claim it searched nothing.
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

  /** True when the session has been put away, so the live listing leaves it out. */
  public isArchived(sessionId: string): boolean {
    return this.state.archived[sessionId] ?? false;
  }

  /** True when that working directory is a pinned project. */
  public isPinned(cwd: string): boolean {
    return this.state.pinned[cwd] ?? false;
  }

  /**
   * The pinned projects in the order they are shown; the sidebar sorts by it
   * and `movePin` moves within it. Off the flag, not off the ranks: the flag
   * is what a pin is, and a rank is only where it sits, so a project heard of
   * without one sorts last rather than falling out of the pinned altogether.
   */
  public pinOrder(): readonly string[] {
    return Object.keys(this.state.pinned)
      .filter((cwd) => this.isPinned(cwd))
      .sort((one, other) => this.pinRankOf(one) - this.pinRankOf(other));
  }

  /** Where a pinned project sorts; a directory with no pin sorts after every one that has. */
  public pinRankOf(cwd: string): number {
    return this.state.pinRank[cwd] ?? Number.MAX_SAFE_INTEGER;
  }

  /** True when that project's sidebar group stands unfolded. Folded is where one starts. */
  public isExpanded(cwd: string): boolean {
    return this.state.expanded[cwd] ?? false;
  }

  /** What somebody called the project, absent when it goes by its directory's base name. */
  public projectLabel(cwd: string): string | undefined {
    return this.state.labels[cwd] ?? undefined;
  }

  /**
   * Names the project a listing groups under, leaving the directory itself
   * alone; `null` puts it back to its base name. Guessed at once and taken
   * back when the server refuses, as a session's own name is.
   */
  public async renameProject(cwd: string, name: string | null): Promise<void> {
    const before = untrack(() => this.state.labels[cwd]);
    await this.guess(
      `labels:${cwd}`,
      (state) => {
        state.labels[cwd] = name;
      },
      (state) => {
        if (before === undefined) {
          delete state.labels[cwd];
        } else {
          state.labels[cwd] = before;
        }
      },
      { type: "set_project_label", cwd, value: name },
      "the server refused the name"
    );
  }

  /**
   * Folds a project's group, or unfolds it. The server keeps it, so the fold
   * survives a reload and every surface opens to the same sidebar.
   */
  public setExpanded(cwd: string, value: boolean): Promise<void> {
    return this.flag(
      { type: "set_project_expanded", cwd, value },
      "expanded",
      cwd,
      value,
      "the server refused the fold"
    );
  }

  /** The name somebody wrote for the session, absent when it goes by its opening message. */
  public sessionName(sessionId: string): string | undefined {
    return this.state.names[sessionId] ?? undefined;
  }

  /**
   * Names the session through pi's own name, so the terminal's picker shows
   * it too; `null` clears it back to its opening message. Guessed at once, so
   * a rename queued behind a running turn shows on the row it was typed on
   * rather than nowhere; taken back when the server refuses. Only the name
   * itself is guessed — a cleared one falls back to a digest of the opening
   * message, which the server holds and this client does not.
   */
  public async rename(sessionId: string, name: string | null): Promise<void> {
    const before = untrack(() => this.state.names[sessionId]);
    await this.guess(
      `names:${sessionId}`,
      (state) => {
        state.names[sessionId] = name;
      },
      (state) => {
        if (before === undefined) {
          delete state.names[sessionId];
        } else {
          state.names[sessionId] = before;
        }
      },
      { type: "set_session_name", sessionId, value: name },
      "the server refused the name"
    );
  }

  /** Puts the session away, out of the live listing, or brings it back. */
  public setArchived(sessionId: string, value: boolean): Promise<void> {
    return this.flag(
      { type: "set_session_archived", sessionId, value },
      "archived",
      sessionId,
      value,
      "the server refused the change"
    );
  }

  /** Holds the session unread until it is answered; survives reading it. */
  public markUnread(sessionId: string, value: boolean): Promise<void> {
    return this.flag(
      { type: "set_session_unread", sessionId, value },
      "unread",
      sessionId,
      value,
      "the server refused the mark"
    );
  }

  /** Pins a working directory, not a session: every session in it sorts first. */
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
   * Swaps a pinned project with its neighbour and sends the whole order, so
   * the row moves on the press rather than on the listing that follows it.
   * The order is the server's, which can name a project this page has no rows
   * for; a swap past one of those reads as a press that did nothing, and a
   * second press moves on.
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

  /**
   * A flag the row draws from this store alone: guessed at once so the row
   * answers the click, taken back when the server refuses, and confirmed by
   * the broadcast that follows the command.
   */
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

  /**
   * Paints `apply` before the command goes out and `restore` if it is refused,
   * holding `key` for as long as the answer is outstanding so a listing the
   * server computed before the command reached it leaves the guess standing.
   */
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
          // Said before this attach, and possibly settled while the socket was
          // down; the replay that follows re-announces every dialog still
          // standing, this session's or the next one's.
          draft.notices = [];
          draft.toasts = [];
          draft.requests = [];
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
      case "ui_notice":
        this.setState((draft) => {
          const notice = {
            id: event.id,
            severity: event.severity,
            text: event.text,
            ...(event.command === undefined ? {} : { command: event.command }),
          };
          // One modal for the whole dispatch: a login flow says something,
          // asks, and says something else, and that is one panel.
          if (notice.command === undefined) {
            draft.toasts.push(notice);
          } else {
            draft.notices.push(notice);
          }
        });
        return;
      case "ui_request":
        this.setState((draft) => {
          // Two dispatches nest, and a spontaneous handler may ask over
          // either: each question waits its turn rather than evicting the
          // one on screen.
          draft.requests.push(event);
        });
        return;
      // Whoever answered it, the question is settled: another window, or the
      // server answering for a reader who never arrived.
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
      // A sidecar write moves no session file, so no listing is invalidated
      // by it: these are the only word a held row gets.
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
          // A patch: a fold says nothing about the pin beside it, and vice versa.
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
          draft.repoRevision = event.repoRevision ?? "";
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

  /** Takes one send's words back off the row it drew them into, and the row with them once nothing is left. */
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
