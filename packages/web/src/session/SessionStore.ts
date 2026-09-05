import { createStore, type Store, type StoreSetter } from "solid-js";

import type { PickerItem } from "#core/picker/PickerItem";
import { RemoteFilePickerSuggestionEngine } from "#core/picker/RemoteFilePickerSuggestionEngine";
import type { ToolView } from "#core/view/ViewBlock";
import type { AttachmentRef } from "#protocol/Command";
import type {
  DurableEvent,
  ModelView,
  ServerEvent,
  SessionStatus,
  SessionSummaryView,
  TurnStats,
} from "#protocol/ServerEvent";
import { isDurableEvent } from "#protocol/ServerEvent";
import { WsClient, type ConnectionStatus } from "../ws/WsClient";

export type LiveTool = {
  readonly callId: string;
  readonly name: string;
  readonly view: ToolView;
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

type OptimisticMessage = {
  id: string;
  text: string;
};

/**
 * Store state is a draft the setter mutates, so its fields are deliberately
 * mutable; consumers only ever see it through the readonly `Store<T>` view.
 */
export type SessionState = {
  connection: ConnectionStatus;
  sessionId: string;
  cwd: string;
  model: string;
  thinking: string;
  cost: number;
  agent: SessionStatus;
  tps: number | undefined;
  contextPercent: number | undefined;
  contextWindow: number | undefined;
  branch: string | undefined;
  dirty: boolean;
  durable: DurableEvent[];
  liveMessageId: string;
  liveText: string;
  liveTools: LiveTool[];
  optimistic: OptimisticMessage[];
  stats: TurnStats | undefined;
  error: string | undefined;
  /** Highest durable seq this browser has painted, per session. */
  seen: Record<string, number>;
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

  public constructor(options: SessionStoreOptions) {
    const [state, setState] = createStore<SessionState>({
      connection: "closed",
      sessionId: "",
      cwd: options.cwd ?? "",
      model: "",
      thinking: "",
      cost: 0,
      agent: "idle",
      tps: undefined,
      contextPercent: undefined,
      contextWindow: undefined,
      branch: undefined,
      dirty: false,
      durable: [],
      liveMessageId: "",
      liveText: "",
      liveTools: [],
      optimistic: [],
      stats: undefined,
      error: undefined,
      seen: readSeen(),
    });
    this.state = state;
    this.setState = setState;
    this.client = new WsClient({
      url: options.url,
      ...(options.sessionId === undefined
        ? {}
        : { sessionId: options.sessionId }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
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
    if (!response.success) {
      throw new Error(response.error ?? "attach was refused");
    }
  }

  public dispose(): void {
    this.client.close();
  }

  /**
   * What the transcript paints: the durable log, then `trailing()`. The two
   * halves are also exposed separately so the transcript can memoise the
   * durable flattening instead of redoing it on every delta.
   */
  public timeline(): readonly DurableEvent[] {
    return [...this.state.durable, ...this.trailing()];
  }

  /**
   * This client's own unacknowledged additions. The live turn is shaped as an
   * ordinary assistant `message` so the row builder dedupes its tool calls
   * against the durable ones on `callId` with no special case anywhere.
   */
  public trailing(): readonly DurableEvent[] {
    const trailing: DurableEvent[] = [];
    // Nothing has been written yet, so the only honest stamp is "now"; the
    // durable event that supersedes this one carries pi's own.
    const timestamp = Date.now();
    for (const pending of this.state.optimistic) {
      trailing.push({
        seq: 0,
        type: "message",
        messageId: pending.id,
        role: "user",
        text: pending.text,
        timestamp,
      });
    }
    if (this.state.liveText !== "" || this.state.liveTools.length > 0) {
      trailing.push({
        seq: 0,
        type: "message",
        messageId: this.streamingId(),
        role: "assistant",
        text: this.state.liveText,
        timestamp,
        toolCalls: this.state.liveTools.map((tool) => ({
          callId: tool.callId,
          name: tool.name,
          view: tool.view,
        })),
      });
    }
    return trailing;
  }

  /** The message id whose markdown must stay un-finalised, if any. */
  public streamingId(): string {
    return this.state.liveMessageId === "" ? "live" : this.state.liveMessageId;
  }

  public isBusy(): boolean {
    return this.state.agent !== "idle";
  }

  public async prompt(
    text: string,
    attachments: readonly UploadedAttachment[] = []
  ): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === "" && attachments.length === 0) {
      return;
    }
    const id = `optimistic:${++this.optimisticId}`;
    this.setState((draft) => {
      draft.optimistic.push({ id, text: trimmed });
      draft.error = undefined;
    });
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
      this.dropOptimistic(id);
      this.setState((draft) => {
        draft.error = (err as Error).message;
      });
    }
  }

  public async cancel(): Promise<void> {
    await this.client
      .send({ type: "cancel", sessionId: this.state.sessionId })
      .catch(() => undefined);
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
    return response?.sessions ?? [];
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
   * The read cursor moves forward only, and is written through to
   * `localStorage` on the spot: a tab closed mid-turn must not come back
   * claiming it never read the turn it painted.
   */
  private markSeen(sessionId: string, seq: number): void {
    if (sessionId === "" || (this.state.seen[sessionId] ?? 0) >= seq) {
      return;
    }
    // Written from the value going in, not from `state` after the fact:
    // store writes land on a microtask, so reading it back here would
    // persist the cursor one event behind.
    const seen = { ...this.state.seen, [sessionId]: seq };
    this.setState((draft) => {
      draft.seen[sessionId] = seq;
    });
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
    } catch {
      // Private mode, a full quota, or no storage at all: unread is a nicety.
    }
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
    await this.client.attachTo({ sessionId });
  }

  public async newSession(cwd?: string): Promise<void> {
    await this.client.attachTo(cwd === undefined ? {} : { cwd });
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
      case "attached":
        this.setState((draft) => {
          // A different session means a different log, so the ordinals this
          // client holds mean nothing; the same one means resume, and the
          // tail it is about to be sent continues what it already has.
          if (draft.sessionId !== event.sessionId) {
            draft.durable = [];
            draft.optimistic = [];
          }
          draft.sessionId = event.sessionId;
          draft.cwd = event.cwd;
          // The server re-sends the whole in-flight turn on every attach, so
          // keeping any of it here would double the text.
          draft.liveText = "";
          draft.liveMessageId = "";
          draft.liveTools = [];
          draft.error = undefined;
        });
        // Attaching is reading: the replay that follows this frame paints
        // everything up to `head`.
        this.markSeen(event.sessionId, event.head);
        return;
      case "message_start":
        this.setState((draft) => {
          draft.liveMessageId = event.messageId;
          draft.liveText = "";
        });
        return;
      case "text_delta":
        this.setState((draft) => {
          if (draft.liveMessageId !== event.messageId) {
            draft.liveMessageId = event.messageId;
            draft.liveText = "";
          }
          draft.liveText += event.delta;
        });
        return;
      case "tool_call":
        this.setState((draft) => {
          upsertTool(draft.liveTools, {
            callId: event.callId,
            name: event.name,
            view: event.view,
          });
        });
        return;
      case "tool_update":
        this.setState((draft) => {
          const existing = draft.liveTools.find(
            (tool) => tool.callId === event.callId
          );
          upsertTool(draft.liveTools, {
            callId: event.callId,
            name: existing?.name ?? "",
            view: event.view,
          });
        });
        return;
      case "picker_invalidate":
        void this.files.refreshRelative();
        return;
      case "session_state":
        this.setState((draft) => {
          draft.cwd = event.cwd;
          draft.model = event.model;
          draft.thinking = event.thinking;
          draft.cost = event.cost;
          draft.agent = event.status;
          draft.tps = event.tps;
          draft.contextPercent = event.contextPercent;
          draft.contextWindow = event.contextWindow;
          draft.branch = event.branch;
          draft.dirty = event.dirty ?? false;
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
      if (event.type === "message" && event.role === "assistant") {
        draft.liveText = "";
        draft.liveMessageId = "";
      }
      if (event.type === "message" && event.role === "user") {
        const at = draft.optimistic.findIndex((pending) =>
          event.text.startsWith(pending.text)
        );
        draft.optimistic.splice(at === -1 ? 0 : at, 1);
      }
      if (event.type === "tool_result") {
        draft.liveTools = draft.liveTools.filter(
          (tool) => tool.callId !== event.callId
        );
      }
    });
    this.markSeen(this.state.sessionId, event.seq);
  }

  private dropOptimistic(id: string): void {
    this.setState((draft) => {
      draft.optimistic = draft.optimistic.filter(
        (pending) => pending.id !== id
      );
    });
  }
}

function upsertTool(tools: LiveTool[], tool: LiveTool): void {
  const at = tools.findIndex((existing) => existing.callId === tool.callId);
  if (at === -1) {
    tools.push(tool);
  } else {
    tools[at] = { ...tools[at], ...tool };
  }
}

function readSeen(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return raw === null ? {} : (JSON.parse(raw) as Record<string, number>);
  } catch {
    return {};
  }
}
