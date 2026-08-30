import type { CommandDraft } from "../../../protocol/src/Command";
import { PROTOCOL_VERSION } from "../../../protocol/src/Protocol";
import {
  isDurableEvent,
  type ResponseEvent,
  type ServerEvent,
} from "../../../protocol/src/ServerEvent";

export type ConnectionStatus =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

/** Which session the client wants; `sessionId` absent means "make me one". */
export type AttachTarget = {
  readonly sessionId?: string;
  readonly cwd?: string;
};

export type WsClientOptions = {
  readonly url: string;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly onEvent: (event: ServerEvent) => void;
  readonly onStatus?: (status: ConnectionStatus) => void;
  /** Delay before retry `attempt` (1-based). Overridden to 0 in tests. */
  readonly backoffMs?: (attempt: number) => number;
};

type Pending = {
  readonly resolve: (response: ResponseEvent) => void;
  readonly reject: (error: Error) => void;
};

const MAX_BACKOFF_MS = 10_000;

function defaultBackoff(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 250 * 2 ** (attempt - 1));
}

/**
 * The transport half of pim-web: one socket, one attached session, and a seq
 * cursor that survives the socket.
 *
 * Reconnect is not error handling here, it is the product: a phone that slept
 * for an hour re-attaches with `fromSeq` set to the last durable ordinal it
 * painted and the server replays exactly the tail beyond it. Nothing is
 * buffered on this side, so nothing can be lost by dropping the socket — the
 * cursor is the whole of the client's memory of the transport.
 *
 * DOM-free on purpose: only `WebSocket` and `setTimeout`, so it is driven in
 * tests by the same real gateway the CLI probe runs against.
 */
export class WsClient {
  private readonly options: WsClientOptions;
  private readonly pending = new Map<string, Pending>();
  private socket: WebSocket | undefined;
  private target: AttachTarget;
  private cursor = 0;
  private nextId = 0;
  private attempt = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  /**
   * Frames between an `attach` going out and its `attached` coming back belong
   * to whatever this connection was looking at before, so they are dropped.
   * Without this a session switch on a live socket would feed the old
   * session's tail into the new session's cursor.
   */
  private settled = false;
  private state: ConnectionStatus = "closed";

  public constructor(options: WsClientOptions) {
    this.options = options;
    this.target = {
      ...(options.sessionId === undefined
        ? {}
        : { sessionId: options.sessionId }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    };
  }

  public get status(): ConnectionStatus {
    return this.state;
  }

  public get sessionId(): string | undefined {
    return this.target.sessionId;
  }

  /** Highest durable `seq` this client has painted; the resume cursor. */
  public get seq(): number {
    return this.cursor;
  }

  /** Where `POST /upload` lives, derived from the socket URL. */
  public get httpUrl(): string {
    return this.options.url.replace(/^ws/, "http");
  }

  public async connect(): Promise<ResponseEvent> {
    await this.openSocket();
    return await this.sendAttach();
  }

  /**
   * Point this connection at another session, or at a new one. The cursor
   * resets because `seq` is an ordinal inside one session's log and means
   * nothing in another's.
   */
  public async attachTo(target: AttachTarget): Promise<ResponseEvent> {
    this.target = target;
    this.cursor = 0;
    if (this.socket?.readyState !== WebSocket.OPEN) {
      this.cancelRetry();
      return await this.connect();
    }
    return await this.sendAttach();
  }

  public send(command: CommandDraft): Promise<ResponseEvent> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("not connected"));
    }
    const id = `web-${++this.nextId}`;
    return new Promise<ResponseEvent>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ ...command, id }));
    });
  }

  public close(): void {
    this.disposed = true;
    this.cancelRetry();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    this.rejectPending(new Error("client closed"));
    this.setStatus("closed");
  }

  private openSocket(): Promise<void> {
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    const socket = new WebSocket(this.options.url);
    this.socket = socket;
    this.settled = false;
    socket.addEventListener("message", (event) => {
      this.receive(String((event as MessageEvent).data));
    });
    socket.addEventListener("close", () => {
      this.onClose(socket);
    });
    return new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => {
        this.attempt = 0;
        this.setStatus("open");
        resolve();
      });
      socket.addEventListener("error", () => {
        reject(new Error(`could not connect to ${this.options.url}`));
      });
    });
  }

  private sendAttach(): Promise<ResponseEvent> {
    this.settled = false;
    return this.send({
      type: "attach",
      protocolVersion: PROTOCOL_VERSION,
      ...(this.target.sessionId === undefined
        ? {}
        : { sessionId: this.target.sessionId }),
      ...(this.target.cwd === undefined ? {} : { cwd: this.target.cwd }),
      fromSeq: this.cursor,
    });
  }

  private onClose(socket: WebSocket): void {
    if (this.socket !== socket) {
      return;
    }
    this.socket = undefined;
    this.rejectPending(new Error("socket closed"));
    if (this.disposed) {
      this.setStatus("closed");
      return;
    }
    this.setStatus("reconnecting");
    this.scheduleRetry();
  }

  private cancelRetry(): void {
    if (this.retry !== undefined) {
      clearTimeout(this.retry);
      this.retry = undefined;
    }
  }

  private scheduleRetry(): void {
    if (this.retry !== undefined) {
      return;
    }
    const attempt = ++this.attempt;
    const delay = (this.options.backoffMs ?? defaultBackoff)(attempt);
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.reconnect();
    }, delay);
    // A pending retry must never hold a Bun test process open.
    (this.retry as { unref?: () => void }).unref?.();
  }

  private async reconnect(): Promise<void> {
    if (this.disposed) {
      return;
    }
    try {
      await this.openSocket();
      await this.sendAttach();
    } catch {
      if (!this.disposed) {
        this.scheduleRetry();
      }
    }
  }

  private receive(raw: string): void {
    let event: ServerEvent;
    try {
      event = JSON.parse(raw) as ServerEvent;
    } catch {
      return;
    }
    if (event.type === "response") {
      const waiter = this.pending.get(event.id);
      this.pending.delete(event.id);
      waiter?.resolve(event);
      return;
    }
    if (event.type === "attached") {
      this.settled = true;
      this.target = { sessionId: event.sessionId, cwd: event.cwd };
    } else if (!this.settled) {
      return;
    }
    if (isDurableEvent(event)) {
      // The server already filters on `fromSeq`; this makes a duplicate
      // impossible even if a future one does not.
      if (event.seq <= this.cursor) {
        return;
      }
      this.cursor = event.seq;
    }
    this.options.onEvent(event);
  }

  private rejectPending(error: Error): void {
    const waiters = [...this.pending.values()];
    this.pending.clear();
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.state === status) {
      return;
    }
    this.state = status;
    this.options.onStatus?.(status);
  }
}
