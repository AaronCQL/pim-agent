import type { CommandDraft } from "#protocol/Command";
import {
  isAttachScoped,
  isDurableEvent,
  type ResponseEvent,
  type ServerEvent,
} from "#protocol/ServerEvent";

export type ConnectionStatus =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

/** No `sessionId` means create a new session. */
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
  /** A reconnect's attach was refused: the socket is open but attached to nothing. */
  readonly onRefused?: (response: ResponseEvent) => void;
  /** The least time between two dials. */
  readonly retryMs?: number;
  /** How long a probe on wake, or a first dial, may go unanswered; each dial that never opens doubles the next one's, to 4×, which is also what a reconnect's attach gets. */
  readonly timeoutMs?: number;
};

type Pending = {
  readonly resolve: (response: ResponseEvent) => void;
  readonly reject: (error: Error) => void;
};

const RETRY_MS = 1000;
// A handshake that lost a packet to a waking network is redialled sooner than TCP retransmits it.
const TIMEOUT_MS = 2000;

/**
 * One socket and one attached session, with a seq cursor that survives reconnects.
 *
 * Never trusts the browser to report a dead socket: a suspended mobile page can lose
 * `close`, or keep an `OPEN` socket nothing reaches. Every way a socket ends goes
 * through `drop`, and `wake` checks the socket itself rather than the last event.
 */
export class WsClient {
  private readonly options: WsClientOptions;
  private readonly pending = new Map<string, Pending>();
  private socket: WebSocket | undefined;
  private target: AttachTarget;
  private cursor = 0;
  private nextId = 0;
  private retrying = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private dialedAt = 0;
  /** Dials in a row that never opened; a network this slow gets longer to answer. */
  private misses = 0;
  /** Frames received, from any socket; a socket that moved it is alive. */
  private heard = 0;
  private disposed = false;
  /** Sent on every attach; an inattentive client never marks a turn read. */
  private attention = true;
  /** False between an `attach` and its `attached`, when frames still belong to the old session. */
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

  public get attentive(): boolean {
    return this.attention;
  }

  /** Highest durable `seq` received; the resume cursor. */
  public get seq(): number {
    return this.cursor;
  }

  public get httpUrl(): string {
    return this.options.url.replace(/^ws/, "http");
  }

  public async connect(): Promise<ResponseEvent> {
    await this.openSocket();
    return await this.sendAttach();
  }

  /** A refusal restores the previous target and cursor. */
  public async attachTo(target: AttachTarget): Promise<ResponseEvent> {
    const previous = this.target;
    const cursor = this.cursor;
    this.target = target;
    this.cursor = 0;
    const live = this.socket?.readyState === WebSocket.OPEN;
    if (!live) {
      // Still dialling, or dead without an event: this attach dials afresh.
      if (this.socket !== undefined) {
        this.drop(this.socket);
      }
      this.cancelRetry();
    }
    const response = live ? await this.sendAttach() : await this.connect();
    if (!response.success) {
      this.target = previous;
      this.cursor = cursor;
      this.settled = live;
    }
    return response;
  }

  public send(command: CommandDraft): Promise<ResponseEvent> {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) {
      // A socket that died without an event is found out here.
      if (socket !== undefined && socket.readyState !== WebSocket.CONNECTING) {
        this.drop(socket);
      }
      return Promise.reject(new Error("not connected"));
    }
    const id = `web-${++this.nextId}`;
    return new Promise<ResponseEvent>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ ...command, id }));
    });
  }

  /** Sent now if connected, otherwise on the next attach. */
  public setAttention(value: boolean): void {
    if (this.attention === value) {
      return;
    }
    this.attention = value;
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }
    void this.send({ type: "attention", value }).catch(() => undefined);
  }

  /** The page is back: replace a socket that died unannounced, and test one that looks open. */
  public wake(): void {
    if (this.disposed) {
      return;
    }
    // Whatever the network was before the page slept, it is another one now.
    this.misses = 0;
    const socket = this.socket;
    if (socket?.readyState === WebSocket.OPEN) {
      this.expect(
        socket,
        this.send({ type: "attention", value: this.attention })
      );
      return;
    }
    // A young dial is left alone, so a burst of wake events dials once; an older one began before the sleep.
    if (
      socket?.readyState === WebSocket.CONNECTING &&
      Date.now() - this.dialedAt < this.timeoutMs
    ) {
      return;
    }
    if (socket !== undefined) {
      this.drop(socket);
    }
    // The retry timer may have been frozen with the page.
    if (this.state === "reconnecting") {
      this.cancelRetry();
      void this.reconnect();
    }
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
    this.setStatus(this.retrying ? "reconnecting" : "connecting");
    const socket = new WebSocket(this.options.url);
    this.socket = socket;
    this.settled = false;
    this.dialedAt = Date.now();
    socket.addEventListener("message", (event) => {
      if (this.socket === socket) {
        this.heard++;
        this.receive(String((event as MessageEvent).data));
      }
    });
    let opened = false;
    return new Promise<void>((resolve, reject) => {
      // Any one of these ends the socket; a browser may send `error` without `close`.
      const end = (): void => {
        clearTimeout(timeout);
        if (!opened && this.socket === socket) {
          this.misses++;
        }
        reject(new Error(`could not connect to ${this.options.url}`));
        this.drop(socket);
      };
      // A socket stuck connecting fires no events.
      const timeout = this.timer(end, 2 ** Math.min(this.misses, 2));
      socket.addEventListener("error", end);
      socket.addEventListener("close", end);
      socket.addEventListener("open", () => {
        if (this.socket !== socket) {
          end();
          return;
        }
        opened = true;
        clearTimeout(timeout);
        this.misses = 0;
        this.retrying = false;
        this.setStatus("open");
        resolve();
      });
    });
  }

  /** Drops a socket that stays silent while `answer` is due; any frame at all proves it alive. */
  private expect(socket: WebSocket, answer: Promise<unknown>, scale = 1): void {
    const heard = this.heard;
    const timeout = this.timer(() => {
      if (this.heard === heard) {
        this.drop(socket);
      }
    }, scale);
    const settle = (): void => {
      clearTimeout(timeout);
    };
    void answer.then(settle, settle);
  }

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? TIMEOUT_MS;
  }

  private timer(fire: () => void, scale = 1): ReturnType<typeof setTimeout> {
    const timeout = setTimeout(fire, this.timeoutMs * scale);
    (timeout as { unref?: () => void }).unref?.();
    return timeout;
  }

  private sendAttach(): Promise<ResponseEvent> {
    this.settled = false;
    return this.send({
      type: "attach",
      ...(this.target.sessionId === undefined
        ? {}
        : { sessionId: this.target.sessionId }),
      ...(this.target.cwd === undefined ? {} : { cwd: this.target.cwd }),
      ...(this.target.like === undefined ? {} : { like: this.target.like }),
      fromSeq: this.cursor,
      attentive: this.attention,
    });
  }

  /** The one way a socket ends, and the only place a retry is scheduled. A socket already replaced is just closed. */
  private drop(socket: WebSocket): void {
    socket.close();
    if (this.socket !== socket) {
      return;
    }
    this.socket = undefined;
    this.rejectPending(new Error("socket closed"));
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
    this.retrying = true;
    // Paces dials, not failures: a dial that already timed out is followed at once.
    const since = Date.now() - this.dialedAt;
    this.retry = setTimeout(
      () => {
        this.retry = undefined;
        void this.reconnect();
      },
      Math.max(0, (this.options.retryMs ?? RETRY_MS) - since)
    );
    (this.retry as { unref?: () => void }).unref?.();
  }

  private async reconnect(): Promise<void> {
    if (this.disposed) {
      return;
    }
    let response: ResponseEvent;
    try {
      await this.openSocket();
      const attach = this.sendAttach();
      // The server may be opening the session cold, so this waits as long as the slowest dial.
      if (this.socket !== undefined) {
        this.expect(this.socket, attach, 4);
      }
      response = await attach;
    } catch {
      // Whatever failed went through `drop`, which scheduled the retry.
      return;
    }
    if (!response.success) {
      this.options.onRefused?.(response);
    }
  }

  private receive(raw: string): void {
    let frame: ServerEvent;
    try {
      frame = JSON.parse(raw) as ServerEvent;
    } catch {
      return;
    }
    // Dispatched synchronously so the resume renders in one pass.
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
    if (event.type === "attached") {
      this.settled = true;
      this.target = { sessionId: event.sessionId, cwd: event.cwd };
    } else if (!this.settled && isAttachScoped(event)) {
      return;
    }
    if (isDurableEvent(event)) {
      // Belt and braces: the server already filters on `fromSeq`.
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
