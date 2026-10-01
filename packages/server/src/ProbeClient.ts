import { basename } from "node:path";

import type { PickerItem } from "#core/picker/PickerItem";
import { RemoteFilePickerSuggestionEngine } from "#core/picker/RemoteFilePickerSuggestionEngine";
import type { ExtensionEntry } from "#core/shared/PiExtensions";
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
  /** Omit to have the server create one. */
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly fromSeq?: number;
  readonly attentive?: boolean;
  readonly onEvent?: (event: ServerEvent) => void;
  /** Keystroke debounce for `files`; 0 makes tests deterministic. */
  readonly debounceMs?: number;
};

/** The `POST /upload` response. */
export type UploadedFile = {
  readonly id: string;
  readonly path: string;
  /** Server-relative. */
  readonly url: string;
  readonly mimeType: string;
  readonly isImage: boolean;
};

type Pending = {
  readonly resolve: (response: ResponseEvent) => void;
  readonly reject: (err: Error) => void;
};

/** Headless protocol client for tests and the probe CLI. */
export class ProbeClient {
  public sessionId: string | undefined;
  public seq: number;
  public readonly events: ServerEvent[] = [];
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
    return ok(response).items ?? [];
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
    return ok(response).items ?? [];
  }

  /** Child events stay enveloped in `events`. */
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

  public async listSessions(
    scope: SessionScope = {}
  ): Promise<SessionListing["sessions"]> {
    return (await this.catalogue(scope)).sessions;
  }

  public async catalogue(scope: SessionScope = {}): Promise<SessionListing> {
    const response = ok(await this.send({ type: "list_sessions", ...scope }));
    return {
      sessions: response.sessions ?? [],
      projects: response.projects ?? [],
    };
  }

  public async search(
    query: string,
    scope: SearchScope = {}
  ): Promise<SessionSearch> {
    const response = ok(
      await this.send({ type: "search_sessions", query, ...scope })
    );
    return {
      hits: response.hits ?? [],
      dropped: response.dropped ?? [],
      scanned: response.scanned ?? 0,
    };
  }

  public rename(
    sessionId: string,
    value: string | null
  ): Promise<ResponseEvent> {
    return this.send({ type: "set_session_name", sessionId, value });
  }

  public setArchived(
    sessionId: string,
    value: boolean
  ): Promise<ResponseEvent> {
    return this.send({ type: "set_session_archived", sessionId, value });
  }

  public markUnread(sessionId: string, value: boolean): Promise<ResponseEvent> {
    return this.send({ type: "set_session_unread", sessionId, value });
  }

  public setPinned(cwd: string, value: boolean): Promise<ResponseEvent> {
    return this.send({ type: "set_project_pinned", cwd, value });
  }

  public setPinOrder(order: readonly string[]): Promise<ResponseEvent> {
    return this.send({ type: "set_pin_order", order });
  }

  public setExpanded(cwd: string, value: boolean): Promise<ResponseEvent> {
    return this.send({ type: "set_project_expanded", cwd, value });
  }

  public setLabel(cwd: string, value: string | null): Promise<ResponseEvent> {
    return this.send({ type: "set_project_label", cwd, value });
  }

  public async listModels(): Promise<{
    readonly models: readonly ModelView[];
    readonly thinkingLevels: readonly string[];
  }> {
    const response = ok(await this.send({ type: "list_models" }));
    return {
      models: response.models ?? [],
      thinkingLevels: response.thinkingLevels ?? [],
    };
  }

  public async listExtensions(): Promise<readonly ExtensionEntry[]> {
    return ok(await this.send({ type: "list_extensions" })).extensions ?? [];
  }

  public async setExtension(id: string, value: boolean): Promise<void> {
    ok(await this.send({ type: "set_extension", extensionId: id, value }));
  }

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
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(
          new Error(`timed out waiting for an event after ${timeoutMs}ms`)
        );
      }, timeoutMs);
      timer.unref?.();
      const waiter = {
        test,
        resolve: (event: ServerEvent) => {
          clearTimeout(timer);
          resolve(event);
        },
      };
      this.waiters.add(waiter);
    });
  }

  /** Closes with an abnormal code, like a killed client. */
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

function ok(response: ResponseEvent): ResponseEvent {
  if (!response.success) {
    throw new Error(response.error ?? "command failed");
  }
  return response;
}
