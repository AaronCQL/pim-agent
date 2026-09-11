import type { ServerWebSocket } from "bun";

import {
  isDurableEvent,
  type ServerEvent,
  type StreamEvent,
} from "#protocol/ServerEvent";
import type { SessionProjection } from "./SessionProjection";

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

/**
 * One subagent log this client is reading, and how far into it that client
 * has been sent. Per-connection rather than per-session: two clients watching
 * two children of the same session are two projections, and neither is the
 * session the connection is attached to.
 */
type SubagentWatch = {
  readonly callId: string;
  readonly projection: SessionProjection;
  /** Highest child `seq` written to the socket; the client's own cursor. */
  cursor: number;
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
  private watch: SubagentWatch | undefined;

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

  /** The subagent this client is reading, if it is reading one. */
  public get watchedCallId(): string | undefined {
    return this.watch?.callId;
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

  /**
   * Read a subagent's log alongside the session this client is attached to.
   * At most one at a time, because a client shows at most one modal.
   *
   * Read-only in the strong sense: nothing here reaches an agent, and the
   * events go out enveloped, so what is drawn from them can never be mistaken
   * for the session's own transcript.
   */
  public async watchSubagent(
    callId: string,
    projection: SessionProjection,
    fromSeq: number
  ): Promise<void> {
    this.watch = { callId, projection, cursor: fromSeq };
    await this.pumpWatch();
  }

  /**
   * Only the named watch, so an `unwatch` for a modal already replaced does
   * not silently close the one that replaced it.
   */
  public unwatchSubagent(callId: string): void {
    if (this.watch?.callId === callId) {
      this.watch = undefined;
    }
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
    this.flushWatch();
  }

  /**
   * The watch goes with the session: it is read out of a child of *this*
   * parent, and the client that moves elsewhere has no modal open over it.
   * Dropping it here is also what keeps an abandoned one from outliving the
   * socket, holding its projection's events for the life of the process.
   */
  public detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.stream = undefined;
    this.watch = undefined;
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
    if (this.touchesWatch(event)) {
      void this.pumpWatch();
    }
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

  /**
   * Live tailing without a poller. The child runs in this process, under the
   * parent tool call the watch is named after, so every frame the parent
   * emits about that call is the parent saying the child has just done
   * something — and a subagent reports progress precisely when the child's
   * model call lands. Its log has been appended to by then, so the read is
   * behind the write rather than racing it.
   */
  private touchesWatch(event: ServerEvent): boolean {
    const callId = this.watch?.callId;
    if (callId === undefined) {
      return false;
    }
    switch (event.type) {
      case "tool_update":
      case "tool_end":
      case "tool_result":
        return event.callId === callId;
      case "replay":
        return event.events.some((inner) => this.touchesWatch(inner));
      default:
        return false;
    }
  }

  private async pumpWatch(): Promise<void> {
    const watch = this.watch;
    if (!watch || this.closed) {
      return;
    }
    await watch.projection.drain();
    // The watch can be closed, or replaced by another child, while the log is
    // being read; what came back then belongs to nobody.
    if (this.watch !== watch) {
      return;
    }
    this.flushWatch();
  }

  /**
   * Everything the child log has that this client has not, as one envelope.
   * The cursor moves only once the frame is on the socket, so a lagging
   * client re-derives its tail on `drain` exactly as the session's own does.
   */
  private flushWatch(): void {
    const watch = this.watch;
    if (!watch || this.closed || this.paused) {
      return;
    }
    const events = watch.projection.since(watch.cursor);
    const last = events.at(-1);
    if (!last) {
      return;
    }
    const status = this.ws.send(
      JSON.stringify({
        type: "subagent_events",
        callId: watch.callId,
        events,
      })
    );
    if (status === 0) {
      this.paused = true;
      return;
    }
    watch.cursor = last.seq;
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
