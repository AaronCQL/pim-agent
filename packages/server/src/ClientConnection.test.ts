import type { ServerWebSocket } from "bun";
import { expect, test } from "bun:test";

import type {
  DurableEvent,
  ServerEvent,
  StreamEvent,
} from "#protocol/ServerEvent";
import { ClientConnection, type AttachableStream } from "./ClientConnection";

/** A socket that reports whatever backpressure a test wants it to. */
class FakeSocket {
  public readonly frames: string[] = [];
  public buffered = 0;
  public dropping = false;

  public send(data: string): number {
    if (this.dropping) {
      return 0;
    }
    this.frames.push(data);
    return data.length;
  }

  public getBufferedAmount(): number {
    return this.buffered;
  }

  /** Frames flattened: a resume is one frame carrying many events. */
  public get events(): readonly ServerEvent[] {
    const events: ServerEvent[] = [];
    for (const frame of this.frames) {
      const event = JSON.parse(frame) as ServerEvent;
      events.push(...(event.type === "replay" ? event.events : [event]));
    }
    return events;
  }

  public get seqs(): readonly number[] {
    return this.events.flatMap((event) => ("seq" in event ? [event.seq] : []));
  }
}

class FakeStream implements AttachableStream {
  public readonly sessionId = "fake";
  public readonly durable: DurableEvent[] = [];
  private readonly listeners = new Set<(event: ServerEvent) => void>();

  public subscribe = (listener: (event: ServerEvent) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  public replay = async (fromSeq: number): Promise<readonly StreamEvent[]> => {
    await Bun.sleep(0);
    return [
      ...this.durable.filter((event) => event.seq > fromSeq),
      { type: "session_state" as const, ...STATE },
    ];
  };

  public append(seq: number): DurableEvent {
    const event: DurableEvent = {
      seq,
      type: "message",
      messageId: `m${seq}`,
      role: "user",
      text: `line ${seq}`,
      timestamp: seq * 1000,
    };
    this.durable.push(event);
    for (const listener of this.listeners) {
      listener(event);
    }
    return event;
  }

  public ephemeral(): void {
    for (const listener of this.listeners) {
      listener({ type: "text_delta", messageId: "live", delta: "x" });
    }
  }
}

const STATE = {
  cwd: "/tmp",
  model: "test/echo",
  thinking: "medium",
  cost: 0,
  status: "idle" as const,
};

function build(): {
  readonly socket: FakeSocket;
  readonly stream: FakeStream;
  readonly connection: ClientConnection;
} {
  const socket = new FakeSocket();
  const connection = new ClientConnection(
    socket as unknown as ServerWebSocket<undefined>
  );
  return { socket, stream: new FakeStream(), connection };
}

test("replays from the cursor, then goes live", async () => {
  const { socket, stream, connection } = build();
  stream.append(2);
  stream.append(3);

  await connection.attach(stream, 2);
  stream.append(4);

  expect(socket.seqs).toEqual([3, 4]);
  expect(connection.seq).toBe(4);
});

test("hands the whole resume over as one frame", async () => {
  const { socket, stream, connection } = build();
  for (const seq of [2, 3, 4, 5]) {
    stream.append(seq);
  }

  await connection.attach(stream, 0);

  expect(socket.frames).toHaveLength(1);
  expect(socket.seqs).toEqual([2, 3, 4, 5]);
});

test("reconciles events that land during the replay read", async () => {
  const { socket, stream, connection } = build();
  stream.append(2);

  const attaching = connection.attach(stream, 0);
  stream.append(3);
  stream.ephemeral();
  await attaching;

  expect(socket.seqs).toEqual([2, 3]);
  expect(
    socket.events.filter((event) => event.type === "text_delta")
  ).toHaveLength(0);
});

test("drops events while lagging and re-derives them on drain", async () => {
  const { socket, stream, connection } = build();
  await connection.attach(stream, 0);

  socket.buffered = 4 << 20;
  stream.append(2);
  expect(socket.seqs).toEqual([2]);

  stream.append(3);
  stream.append(4);
  stream.ephemeral();
  expect(socket.seqs).toEqual([2]);

  socket.buffered = 0;
  connection.onDrain();
  await Bun.sleep(5);

  expect(socket.seqs).toEqual([2, 3, 4]);
  expect(connection.seq).toBe(4);
});

test("pauses when the socket drops a frame outright", async () => {
  const { socket, stream, connection } = build();
  await connection.attach(stream, 0);

  socket.dropping = true;
  stream.append(2);
  socket.dropping = false;
  stream.append(3);
  expect(socket.seqs).toEqual([]);

  connection.onDrain();
  await Bun.sleep(5);
  expect(socket.seqs).toEqual([2, 3]);
});

test("sends nothing once closed", async () => {
  const { socket, stream, connection } = build();
  await connection.attach(stream, 0);
  const sent = socket.frames.length;
  connection.close();

  stream.append(2);
  connection.send({ type: "response", id: "1", success: true });
  expect(socket.frames).toHaveLength(sent);
});
