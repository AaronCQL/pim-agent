import type { ServerWebSocket } from "bun";

import { isDurableEvent, type ServerEvent } from "#protocol/ServerEvent";

/**
 * The half of `SessionStream` a connection needs: subscribe to what happens
 * next, and ask for everything missed. Structural so the backpressure path can
 * be driven without an agent behind it.
 */
export type AttachableStream = {
  readonly subscribe: (listener: (event: ServerEvent) => void) => () => void;
  readonly replay: (fromSeq: number) => Promise<readonly ServerEvent[]>;
  readonly sessionId: string;
};

/** Bytes queued inside the socket before this client is treated as lagging. */
const HIGH_WATER_MARK = 1 << 20;

/**
 * One WebSocket client, attached to at most one session.
 *
 * Nothing is buffered on this side. A client that cannot keep up is paused and
 * its dropped events are re-derived on `drain` from the session's durable
 * projection and in-flight snapshot, which is exactly the resume handshake run
 * again — so backpressure costs a repaint, never memory and never an event.
 */
export class ClientConnection {
  private readonly ws: ServerWebSocket<undefined>;
  private stream: AttachableStream | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly gate: ServerEvent[] = [];
  private gated = false;
  private paused = false;
  private cursor = 0;
  private closed = false;

  public constructor(ws: ServerWebSocket<undefined>) {
    this.ws = ws;
  }

  public get sessionId(): string | undefined {
    return this.stream?.sessionId;
  }

  /** Highest durable `seq` this client has been handed. */
  public get seq(): number {
    return this.cursor;
  }

  public async attach(
    stream: AttachableStream,
    fromSeq: number
  ): Promise<void> {
    this.detach();
    this.stream = stream;
    this.cursor = fromSeq;
    this.unsubscribe = stream.subscribe((event) => {
      this.onStreamEvent(event);
    });
    await this.sync();
  }

  /** Send something that belongs to no stream, e.g. a command response. */
  public send(event: ServerEvent): void {
    if (this.closed) {
      return;
    }
    this.ws.send(JSON.stringify(event));
  }

  public onDrain(): void {
    if (!this.paused) {
      return;
    }
    this.paused = false;
    void this.sync();
  }

  public detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.stream = undefined;
  }

  public close(): void {
    this.closed = true;
    this.detach();
  }

  /**
   * Replay everything this client is missing, then go live. Live events that
   * land during the read are queued and reconciled against the replay by
   * `seq`; ephemeral ones are discarded because the in-flight snapshot taken
   * at the end of the read already contains them.
   */
  private async sync(): Promise<void> {
    const stream = this.stream;
    if (!stream || this.closed) {
      return;
    }
    this.gated = true;
    const replayed = await stream.replay(this.cursor);
    if (this.stream !== stream || this.closed) {
      return;
    }
    for (const event of replayed) {
      this.write(event);
    }
    for (const event of this.gate) {
      if (isDurableEvent(event)) {
        this.write(event);
      }
    }
    this.gate.length = 0;
    this.gated = false;
  }

  private onStreamEvent(event: ServerEvent): void {
    if (this.gated) {
      this.gate.push(event);
      return;
    }
    this.write(event);
  }

  private write(event: ServerEvent): void {
    if (this.closed || this.paused) {
      return;
    }
    const durable = isDurableEvent(event);
    if (durable && event.seq <= this.cursor) {
      return;
    }
    const status = this.ws.send(JSON.stringify(event));
    if (status === 0) {
      this.paused = true;
      return;
    }
    if (durable) {
      this.cursor = event.seq;
    }
    if (this.ws.getBufferedAmount() > HIGH_WATER_MARK) {
      this.paused = true;
    }
  }
}
