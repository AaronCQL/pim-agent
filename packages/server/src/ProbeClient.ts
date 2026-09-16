import { basename } from "node:path";

import type { PickerItem } from "#core/picker/PickerItem";
import { RemoteFilePickerSuggestionEngine } from "#core/picker/RemoteFilePickerSuggestionEngine";
import type {
  AttachmentRef,
  CommandDraft,
  SearchScope,
  SessionScope,
} from "#protocol/Command";
import {
  isDurableEvent,
  type ModelView,
  type ResponseEvent,
  type ServerEvent,
  type SessionListing,
  type SessionSearch,
} from "#protocol/ServerEvent";

export type ProbeOptions = {
  readonly url: string;
  /** Omit to have the server create a session; the id comes back on attach. */
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly fromSeq?: number;
  /** Sent on the attach frame; false is a client that is connected but not looking. */
  readonly attentive?: boolean;
  /** Called for every frame, in arrival order. */
  readonly onEvent?: (event: ServerEvent) => void;
  /** Keystroke debounce for `files`; 0 makes tests deterministic. */
  readonly debounceMs?: number;
};

/** What `POST /upload` answers with, all of it server-side. */
export type UploadedFile = {
  readonly id: string;
  readonly path: string;
  /** Where the bytes can be read back, relative to the server's origin. */
  readonly url: string;
  readonly mimeType: string;
  readonly isImage: boolean;
};

type Pending = {
  readonly resolve: (response: ResponseEvent) => void;
  readonly reject: (err: Error) => void;
};

/** The reference client: speaks the whole protocol, renders nothing. */
export class ProbeClient {
  public sessionId: string | undefined;
  public seq: number;
  public readonly events: ServerEvent[] = [];
  /** The `@` picker, answered by the server one query at a time. */
  public readonly files: RemoteFilePickerSuggestionEngine;
  private readonly options: ProbeOptions;
  private readonly pending = new Map<string, Pending>();
  private readonly waiters = new Set<{
    readonly test: (event: ServerEvent) => boolean;
    readonly resolve: (event: ServerEvent) => void;
  }>();
  private socket: WebSocket | undefined;
  private nextId = 0;

  public constructor(options: ProbeOptions) {
    this.options = options;
    this.sessionId = options.sessionId;
    this.seq = options.fromSeq ?? 0;
    this.files = new RemoteFilePickerSuggestionEngine(
      (query, limit) => this.pickFiles(query, limit),
      options.debounceMs
    );
  }

  /** Connects and completes the resume handshake; resolves once replay ends. */
  public async connect(): Promise<ResponseEvent> {
    const socket = new WebSocket(this.options.url);
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      this.receive(String(event.data));
    });
    socket.addEventListener("close", (event) => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(`socket closed: ${event.code} ${event.reason}`));
      }
      this.pending.clear();
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => {
        resolve();
      });
      socket.addEventListener("error", () => {
        reject(new Error(`could not connect to ${this.options.url}`));
      });
    });
    return await this.send({
      type: "attach",
      ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
      ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
      ...(this.options.attentive === undefined
        ? {}
        : { attentive: this.options.attentive }),
      fromSeq: this.seq,
    });
  }

  /** Says whether this client's reader is present; regaining it reads the session. */
  public attention(value: boolean): Promise<ResponseEvent> {
    return this.send({ type: "attention", value });
  }

  public send(command: CommandDraft): Promise<ResponseEvent> {
    const socket = this.socket;
    if (!socket) {
      return Promise.reject(new Error("probe is not connected"));
    }
    const id = `probe-${++this.nextId}`;
    const frame = { ...command, id };
    return new Promise<ResponseEvent>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.send(JSON.stringify(frame));
    });
  }

  public prompt(text: string): Promise<ResponseEvent> {
    return this.send({
      type: "user_message",
      sessionId: this.sessionId ?? "",
      text,
    });
  }

  public async pickFiles(
    query: string,
    limit = 50
  ): Promise<readonly PickerItem[]> {
    const response = await this.send({
      type: "pick_files",
      sessionId: this.sessionId ?? "",
      query,
      limit,
    });
    return itemsOf(response);
  }

  public async pickCommands(
    query: string,
    limit?: number
  ): Promise<readonly PickerItem[]> {
    const response = await this.send({
      type: "pick_commands",
      sessionId: this.sessionId ?? "",
      query,
      ...(limit === undefined ? {} : { limit }),
    });
    return itemsOf(response);
  }

  /** Reads one subagent's transcript; its events stay enveloped in `events`. */
  public watchSubagent(callId: string, fromSeq = 0): Promise<ResponseEvent> {
    return this.send({
      type: "watch_subagent",
      sessionId: this.sessionId ?? "",
      callId,
      fromSeq,
    });
  }

  public unwatchSubagent(callId: string): Promise<ResponseEvent> {
    return this.send({ type: "unwatch_subagent", callId });
  }

  /** Pi's session catalogue; answers whether or not this probe is attached. */
  public async listSessions(
    scope: SessionScope = {}
  ): Promise<SessionListing["sessions"]> {
    return (await this.catalogue(scope)).sessions;
  }

  /** The listing whole: the rows the page kept and the projects they came from. */
  public async catalogue(scope: SessionScope = {}): Promise<SessionListing> {
    const response = await this.send({ type: "list_sessions", ...scope });
    if (!response.success) {
      throw new Error(response.error ?? "list_sessions failed");
    }
    return {
      sessions: response.sessions ?? [],
      projects: response.projects ?? [],
    };
  }

  /** Searches every session on disk; an empty query warms the index and answers with no hits. */
  public async search(
    query: string,
    scope: SearchScope = {}
  ): Promise<SessionSearch> {
    const response = await this.send({
      type: "search_sessions",
      query,
      ...scope,
    });
    if (!response.success) {
      throw new Error(response.error ?? "search_sessions failed");
    }
    return {
      hits: response.hits ?? [],
      dropped: response.dropped ?? [],
      scanned: response.scanned ?? 0,
    };
  }

  /** Names a session through pi's own name; `null` clears it back to its opening message. */
  public rename(
    sessionId: string,
    value: string | null
  ): Promise<ResponseEvent> {
    return this.send({ type: "set_session_name", sessionId, value });
  }

  /** Puts a session out of the live listing, or brings it back. */
  public setArchived(
    sessionId: string,
    value: boolean
  ): Promise<ResponseEvent> {
    return this.send({ type: "set_session_archived", sessionId, value });
  }

  /** Holds a session unread until something reads it; survives a listing and a re-attach. */
  public markUnread(sessionId: string, value: boolean): Promise<ResponseEvent> {
    return this.send({ type: "set_session_unread", sessionId, value });
  }

  /** Pins a working directory, not a session. */
  public setPinned(cwd: string, value: boolean): Promise<ResponseEvent> {
    return this.send({ type: "set_project_pinned", cwd, value });
  }

  /** Re-orders the pinned directories; the whole order, pinned ones only. */
  public setPinOrder(order: readonly string[]): Promise<ResponseEvent> {
    return this.send({ type: "set_pin_order", order });
  }

  /** Unfolds a working directory's sidebar group, or folds it. */
  public setExpanded(cwd: string, value: boolean): Promise<ResponseEvent> {
    return this.send({ type: "set_project_expanded", cwd, value });
  }

  /** The model catalogue, plus this session's thinking levels; empty when unattached. */
  public async listModels(): Promise<{
    readonly models: readonly ModelView[];
    readonly thinkingLevels: readonly string[];
  }> {
    const response = await this.send({ type: "list_models" });
    if (!response.success) {
      throw new Error(response.error ?? "list_models failed");
    }
    return {
      models: response.models ?? [],
      thinkingLevels: response.thinkingLevels ?? [],
    };
  }

  /** Transfers a client-local file into the server's world; only the bytes and bare filename are sent. */
  public async upload(localPath: string): Promise<UploadedFile> {
    const file = Bun.file(localPath);
    const form = new FormData();
    form.append("file", file, basename(localPath));
    const response = await fetch(
      `${this.httpUrl}/upload?session=${encodeURIComponent(this.sessionId ?? "")}`,
      { method: "POST", body: form }
    );
    const body = (await response.json()) as UploadedFile & {
      readonly error?: string;
    };
    if (!response.ok) {
      throw new Error(`upload failed: ${body.error ?? response.status}`);
    }
    return body;
  }

  public promptWith(
    text: string,
    attachments: readonly AttachmentRef[]
  ): Promise<ResponseEvent> {
    return this.send({
      type: "user_message",
      sessionId: this.sessionId ?? "",
      text,
      attachments,
    });
  }

  public get httpUrl(): string {
    return this.options.url.replace(/^ws/, "http");
  }

  /** `from` skips frames already received, so a repeated state can be awaited. */
  public waitFor(
    test: (event: ServerEvent) => boolean,
    opts?: { readonly timeoutMs?: number; readonly from?: number }
  ): Promise<ServerEvent> {
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const hit = this.events.slice(opts?.from ?? 0).find(test);
    if (hit) {
      return Promise.resolve(hit);
    }
    return new Promise<ServerEvent>((resolve, reject) => {
      const waiter = { test, resolve };
      this.waiters.add(waiter);
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(
          new Error(`timed out waiting for an event after ${timeoutMs}ms`)
        );
      }, timeoutMs);
      timer.unref?.();
    });
  }

  /** Drops the socket without a close frame, the way a killed client would. */
  public kill(): void {
    this.socket?.close(4000, "probe killed");
    this.socket = undefined;
  }

  public close(): void {
    this.socket?.close();
    this.socket = undefined;
  }

  private receive(raw: string): void {
    const frame = JSON.parse(raw) as ServerEvent;
    if (frame.type === "replay") {
      for (const event of frame.events) {
        this.dispatch(event);
      }
      return;
    }
    this.dispatch(frame);
  }

  private dispatch(event: ServerEvent): void {
    this.events.push(event);
    if (isDurableEvent(event)) {
      this.seq = Math.max(this.seq, event.seq);
    } else if (event.type === "attached") {
      this.sessionId = event.sessionId;
    } else if (event.type === "picker_invalidate") {
      void this.files.refreshRelative();
    } else if (event.type === "response") {
      this.pending.get(event.id)?.resolve(event);
      this.pending.delete(event.id);
    }
    this.options.onEvent?.(event);
    for (const waiter of this.waiters) {
      if (waiter.test(event)) {
        this.waiters.delete(waiter);
        waiter.resolve(event);
      }
    }
  }
}

function itemsOf(response: ResponseEvent): readonly PickerItem[] {
  if (!response.success) {
    throw new Error(response.error ?? "picker query failed");
  }
  return response.items ?? [];
}
