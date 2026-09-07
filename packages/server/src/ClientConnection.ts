import type { ServerWebSocket } from "bun";

import {
  isDurableEvent,
  type ServerEvent,
  type StreamEvent,
} from "#protocol/ServerEvent";

/**
 * The half of `SessionStream` a connection needs: subscribe to what happens
 * next, and ask for everything missed. Structural so the backpressure path can
 * be driven without an agent behind it.
 */
export type AttachableStream = {
  readonly subscribe: (listener: (event: ServerEvent) => void) => () => void;
  readonly replay: (fromSeq: number) => Promise<readonly StreamEvent[]>;
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
   * Replay everything this client is missing as a single frame, then go live.
   * Live events that land during the read are queued and reconciled against
   * the replay by `seq`; ephemeral ones are discarded because the in-flight
   * snapshot taken at the end of the read already contains them.
   *
   * One frame rather than one per event because the receiver pays a render
   * pass per frame: a thousand-line session arriving line by line is a
   * thousand repaints of a document that grows with each one.
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
    const queued = this.gate.filter(isDurableEvent);
    this.gate.length = 0;
    this.gated = false;
    this.writeBatch([...replayed, ...queued]);
  }

  private onStreamEvent(event: ServerEvent): void {
    // A drain of the log and the retires it triggered arrive as one batch,
    // and that is the unit they are correct in: a retire without the durable
    // message beside it leaves the client drawing that step twice. It is held
    // in the gate unwrapped, though — what is reconciled there is events, and
    // an envelope the filter could not see into would take its durable lines
    // down with it.
    if (event.type === "replay") {
      if (this.gated) {
        this.gate.push(...event.events);
        return;
      }
      this.writeBatch(event.events);
      return;
    }
    if (this.gated) {
      this.gate.push(event);
      return;
    }
    this.write(event);
  }

  /**
   * A batch as one `replay` frame. Sent whole or not at all: a socket that
   * refuses it is paused, and `drain` re-derives the resume from the cursor,
   * which has not moved.
   */
  private writeBatch(events: readonly StreamEvent[]): void {
    if (this.closed || this.paused) {
      return;
    }
    // Filtered against a cursor that moves inside the batch: the replay read
    // and the queue behind it can both name the same line.
    let cursor = this.cursor;
    const fresh: StreamEvent[] = [];
    for (const event of events) {
      if (isDurableEvent(event)) {
        if (event.seq <= cursor) {
          continue;
        }
        cursor = event.seq;
      }
      fresh.push(event);
    }
    if (fresh.length === 0) {
      return;
    }
    const status = this.ws.send(
      JSON.stringify({ type: "replay", events: fresh })
    );
    if (status === 0) {
      this.paused = true;
      return;
    }
    this.cursor = cursor;
    if (this.ws.getBufferedAmount() > HIGH_WATER_MARK) {
      this.paused = true;
    }
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
