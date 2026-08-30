import type { CommandDraft } from "../../protocol/src/Command";
import { PROTOCOL_VERSION } from "../../protocol/src/Protocol";
import {
  isDurableEvent,
  type ResponseEvent,
  type ServerEvent,
} from "../../protocol/src/ServerEvent";

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

  /** Answer a parked `approval_request`; only the first answer counts. */
  public approve(callId: string, approved = true): Promise<ResponseEvent> {
    return this.send({
      type: "approve_tool",
      sessionId: this.sessionId ?? "",
      callId,
      approved,
    });
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
    const event = JSON.parse(raw) as ServerEvent;
    this.events.push(event);
    if (isDurableEvent(event)) {
      this.seq = Math.max(this.seq, event.seq);
    } else if (event.type === "attached") {
      this.sessionId = event.sessionId;
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
