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
  dirty: boolean;
  durable: DurableEvent[];
  live: LiveMessage[];
  optimistic: OptimisticMessage[];
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
  /**
   * The read cursors, synchronously. The store copy is the same numbers, but
   * a batch of events writes it many times before anything reads it back, so
   * the guard and the persisted value are taken from here.
   */
  private readonly seen: Record<string, number>;
  private persisting = false;

  public constructor(options: SessionStoreOptions) {
    const seen = readSeen();
    const [state, setState] = createStore<SessionState>({
      connection: "closed",
      sessionId: "",
      cwd: options.cwd ?? "",
      model: "",
      modelLabel: "",
      thinking: "",
      cost: 0,
      agent: "idle",
      tps: undefined,
      contextPercent: undefined,
      contextWindow: undefined,
      branch: undefined,
      dirty: false,
      durable: [],
      live: [],
      optimistic: [],
      loading: false,
      stats: undefined,
      error: undefined,
      seen: { ...seen },
    });
    this.seen = seen;
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
   * This client's own unacknowledged messages: what was typed and not yet
   * echoed back. The live turn is separate — `state.live` — because a
   * streaming message is not a durable one with a flag on it.
   */
  public trailing(): readonly DurableEvent[] {
    // Nothing has been written yet, so the only honest stamp is "now"; the
    // durable event that supersedes this one carries pi's own.
    const timestamp = Date.now();
    return this.state.optimistic.map((pending) => ({
      seq: 0,
      type: "message",
      messageId: pending.id,
      role: "user",
      text: pending.text,
      timestamp,
    }));
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
    this.persistSeen();
  }

  private persistSeen(): void {
    if (this.persisting) {
      return;
    }
    this.persisting = true;
    queueMicrotask(() => {
      this.persisting = false;
      try {
        localStorage.setItem(SEEN_KEY, JSON.stringify(this.seen));
      } catch {
        // Private mode, a full quota, or no storage at all: unread is a nicety.
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

  public async newSession(cwd?: string): Promise<void> {
    await this.attach(cwd === undefined ? {} : { cwd });
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
      await this.client.attachTo(target);
    } catch (error) {
      this.setState((draft) => {
        draft.loading = false;
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
        // Attaching is reading: the replay that follows this frame paints
        // everything up to `head`.
        this.markSeen(event.sessionId, event.head);
        return;
      case "message_start":
        this.setState((draft) => {
          liveMessage(draft.live, event.messageId);
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
          draft.tps = event.tps;
          draft.contextPercent = event.contextPercent;
          draft.contextWindow = event.contextWindow;
          draft.branch = event.branch;
          draft.dirty = event.dirty ?? false;
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
      if (event.type === "message" && event.role === "assistant") {
        // One durable message retires one live one, oldest first: they are
        // written in the order they streamed, and the rest of the turn is
        // still only live.
        draft.live = draft.live.slice(1);
      }
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

  private dropOptimistic(id: string): void {
    this.setState((draft) => {
      draft.optimistic = draft.optimistic.filter(
        (pending) => pending.id !== id
      );
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
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return raw === null ? {} : (JSON.parse(raw) as Record<string, number>);
  } catch {
    return {};
  }
}
