import type { ServerWebSocket } from "bun";

import {
  isDurableEvent,
  type ServerEvent,
  type StreamEvent,
} from "#protocol/ServerEvent";
import type { SessionProjection } from "./SessionProjection";

/** The half of `SessionStream` a connection needs: subscribe, and ask for everything missed. */
export type AttachableStream = {
  readonly subscribe: (listener: (event: ServerEvent) => void) => () => void;
  readonly replay: (fromSeq: number) => Promise<readonly StreamEvent[]>;
  readonly sessionId: string;
};

type SubagentWatch = {
  readonly callId: string;
  readonly projection: SessionProjection;
  cursor: number;
};

const HIGH_WATER_MARK = 1 << 20;

const FRAMES = new WeakMap<object, string>();

export function frame(event: object): string {
  const cached = FRAMES.get(event);
  if (cached !== undefined) {
    return cached;
  }
  const text = JSON.stringify(event);
  FRAMES.set(event, text);
  return text;
}

/** One WebSocket client, attached to at most one session; a lagging client is paused and re-derived on `drain`. */
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

  /** Read a subagent's log alongside the attached session; at most one watch at a time. */
  public async watchSubagent(
    callId: string,
    projection: SessionProjection,
    fromSeq: number
  ): Promise<void> {
    this.watch = { callId, projection, cursor: fromSeq };
    await this.pumpWatch();
  }

  /** Closes only the named watch, so it cannot close the one that replaced it. */
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
    this.ws.send(frame(event));
  }

  public onDrain(): void {
    if (!this.paused) {
      return;
    }
    this.paused = false;
    void this.sync();
    this.flushWatch();
  }

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

  // Gate live events during the read and reconcile by `seq`; ephemeral ones are already in the snapshot.
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
    // Gate a batch unwrapped: the durable filter cannot see into an envelope.
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

  // Sent whole or not at all: the cursor moves only once the frame is on the socket.
  private writeBatch(events: readonly StreamEvent[]): void {
    if (this.closed || this.paused) {
      return;
    }
    // Filter against a cursor that moves inside the batch: replay and queue can name the same line.
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
    if (this.deliver(JSON.stringify({ type: "replay", events: fresh }))) {
      this.cursor = cursor;
    }
  }

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
    // The watch can be closed or replaced during the read.
    if (this.watch !== watch) {
      return;
    }
    this.flushWatch();
  }

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
    const payload = JSON.stringify({
      type: "subagent_events",
      callId: watch.callId,
      events,
    });
    if (this.deliver(payload)) {
      watch.cursor = last.seq;
    }
  }

  private deliver(payload: string): boolean {
    if (this.closed || this.paused) {
      return false;
    }
    const status = this.ws.send(payload);
    if (status === 0) {
      this.paused = true;
      return false;
    }
    if (this.ws.getBufferedAmount() > HIGH_WATER_MARK) {
      this.paused = true;
    }
    return true;
  }

  private write(event: ServerEvent): void {
    if (this.closed || this.paused) {
      return;
    }
    const durable = isDurableEvent(event);
    if (durable && event.seq <= this.cursor) {
      return;
    }
    if (this.deliver(frame(event)) && durable) {
      this.cursor = event.seq;
    }
  }
}
