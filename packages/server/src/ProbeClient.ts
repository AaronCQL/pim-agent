import { basename } from "node:path";

import type { PickerItem } from "#core/picker/PickerItem";
import { RemoteFilePickerSuggestionEngine } from "#core/picker/RemoteFilePickerSuggestionEngine";
import type { AttachmentRef, CommandDraft } from "#protocol/Command";
import { PROTOCOL_VERSION } from "#protocol/Protocol";
import {
  isDurableEvent,
  type ModelView,
  type ResponseEvent,
  type ServerEvent,
  type SessionSummaryView,
} from "#protocol/ServerEvent";

export type ProbeOptions = {
  readonly url: string;
  /** Omit to have the server create a session; the id comes back on attach. */
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly fromSeq?: number;
  /** Called for every frame, in arrival order. */
  readonly onEvent?: (event: ServerEvent) => void;
  /** Sent instead of the real one, to exercise version rejection. */
  readonly protocolVersion?: number;
  /** Keystroke debounce for `files`; 0 makes tests deterministic. */
  readonly debounceMs?: number;
};

/** What `POST /upload` answers with, all of it server-side. */
export type UploadedFile = {
  readonly id: string;
  readonly path: string;
  readonly mimeType: string;
  readonly isImage: boolean;
};

type Pending = {
  readonly resolve: (response: ResponseEvent) => void;
  readonly reject: (err: Error) => void;
};

/**
 * The reference client: it speaks the whole protocol and holds no opinions
 * about rendering. Both the CLI probe and the gateway's own tests drive the
 * server through this, so the transport is never validated by a mock.
 */
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
  private closeInfo:
    | { readonly code: number; readonly reason: string }
    | undefined;

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
      this.closeInfo = { code: event.code, reason: event.reason };
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
      protocolVersion: (this.options.protocolVersion ??
        PROTOCOL_VERSION) as typeof PROTOCOL_VERSION,
      ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
      ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
      fromSeq: this.seq,
    });
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

  /** Pi's session catalogue; answers whether or not this probe is attached. */
  public async listSessions(
    cwd?: string
  ): Promise<readonly SessionSummaryView[]> {
    const response = await this.send({
      type: "list_sessions",
      ...(cwd === undefined ? {} : { cwd }),
    });
    if (!response.success) {
      throw new Error(response.error ?? "list_sessions failed");
    }
    return response.sessions ?? [];
  }

  /**
   * The model catalogue, plus the thinking levels of the model this probe's
   * session is on — empty for a probe that has not attached.
   */
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

  /**
   * Transfers a client-local file into the server's world. The path given here
   * is read locally and then forgotten — only the bytes and the bare filename
   * are sent, and only the server's own path comes back.
   */
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

  /** Resolves when the socket closes, e.g. after a protocol rejection. */
  public async closed(): Promise<{
    readonly code: number;
    readonly reason: string;
  }> {
    while (!this.closeInfo) {
      await Bun.sleep(5);
    }
    return this.closeInfo;
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
