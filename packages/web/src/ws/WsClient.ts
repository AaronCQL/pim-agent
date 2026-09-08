import type { CommandDraft } from "#protocol/Command";
import { CLOSE_PROTOCOL_MISMATCH, PROTOCOL_VERSION } from "#protocol/Protocol";
import {
  isDurableEvent,
  type ResponseEvent,
  type ServerEvent,
} from "#protocol/ServerEvent";

/**
 * `outdated` is terminal and is the only one that is: the server has refused
 * this client's protocol version, and it will refuse the next socket for the
 * same reason. What fixes it is newer code in this tab, which is not
 * something the transport can go and get.
 */
export type ConnectionStatus =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed"
  | "outdated";

/**
 * Which session the client wants; `sessionId` absent means "make me one".
 * `like` names the session a new one should be opened like, and is dropped
 * the moment the server answers: from then on this connection is pointed at
 * a session of its own, which a reconnect resumes rather than re-derives.
 */
export type AttachTarget = {
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly like?: string;
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
  private outdated = false;
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
   *
   * A refusal moves nothing: the server is still attached to the session it
   * was, so this client goes back to reading it. Without that it would hold a
   * target it never reached and a closed gate — dropping every frame of the
   * conversation still on screen, on a socket that is perfectly healthy.
   */
  public async attachTo(target: AttachTarget): Promise<ResponseEvent> {
    const previous = this.target;
    const cursor = this.cursor;
    this.target = target;
    this.cursor = 0;
    const live = this.socket?.readyState === WebSocket.OPEN;
    if (!live) {
      this.cancelRetry();
    }
    const response = live ? await this.sendAttach() : await this.connect();
    if (!response.success) {
      this.target = previous;
      this.cursor = cursor;
      // Only on a socket that was already carrying the old session: a fresh
      // one is attached to nothing, and has nothing to go back to.
      this.settled = live;
    }
    return response;
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
    socket.addEventListener("close", (event) => {
      this.onClose(socket, (event as CloseEvent).code);
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
      ...(this.target.like === undefined ? {} : { like: this.target.like }),
      fromSeq: this.cursor,
    });
  }

  private onClose(socket: WebSocket, code: number): void {
    if (this.socket !== socket) {
      return;
    }
    this.socket = undefined;
    this.rejectPending(new Error("socket closed"));
    if (this.disposed) {
      this.setStatus("closed");
      return;
    }
    // Retrying a refusal is a spin: this server has already read the version
    // it will read again. Reported and left there — what to do about a stale
    // tab is the application's call, and this half of the client has no way
    // to reload one anyway.
    if (code === CLOSE_PROTOCOL_MISMATCH) {
      this.outdated = true;
      this.setStatus("outdated");
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
    if (this.retry !== undefined || this.outdated) {
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
    let frame: ServerEvent;
    try {
      frame = JSON.parse(raw) as ServerEvent;
    } catch {
      return;
    }
    // Fanned out synchronously, which is the whole point of the envelope: a
    // consumer that batches its own work by task sees one task, not one per
    // event, and paints the resume in a single pass.
    if (frame.type === "replay") {
      for (const event of frame.events) {
        this.dispatch(event);
      }
      return;
    }
    this.dispatch(frame);
  }

  private dispatch(event: ServerEvent): void {
    if (event.type === "response") {
      const waiter = this.pending.get(event.id);
      this.pending.delete(event.id);
      waiter?.resolve(event);
      return;
    }
    // Names the session it is about, so it is nobody's tail and cannot
    // disturb a cursor: it passes the gate below rather than waiting behind
    // an attach that may be for a different session entirely.
    if (event.type === "session_activity" || event.type === "update_state") {
      this.options.onEvent(event);
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
