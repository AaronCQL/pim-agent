import type { ServerWebSocket } from "bun";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import type {
  DurableEvent,
  ServerEvent,
  StreamEvent,
} from "#protocol/ServerEvent";
import { ClientConnection, type AttachableStream } from "./ClientConnection";
import { SessionProjection } from "./SessionProjection";

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

  /** The child transcripts this socket was handed, oldest frame first. */
  public get watched(): ReadonlyArray<readonly ServerEvent[]> {
    return this.frames
      .map((frame) => JSON.parse(frame) as ServerEvent)
      .filter((event) => event.type === "subagent_events")
      .map((event) => event.events);
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

  /**
   * The tail as it stood when the read began, the way a projection reads a
   * file: whatever is appended while it is in flight arrives on its own and
   * is the gate's to reconcile.
   */
  public replay = async (fromSeq: number): Promise<readonly StreamEvent[]> => {
    const tail = this.durable.filter((event) => event.seq > fromSeq);
    await Bun.sleep(0);
    return [...tail, { type: "session_state" as const, ...STATE }];
  };

  public append(seq: number): DurableEvent {
    const event = this.record(seq);
    for (const listener of this.listeners) {
      listener(event);
    }
    return event;
  }

  /** A drain of the log as the session emits one: several events, one frame. */
  public drain(...seqs: readonly number[]): void {
    const events = seqs.map((seq) => this.record(seq));
    for (const listener of this.listeners) {
      listener({ type: "replay", events });
    }
  }

  private record(seq: number): DurableEvent {
    const event: DurableEvent = {
      seq,
      type: "message",
      messageId: `m${seq}`,
      role: "user",
      text: `line ${seq}`,
      timestamp: seq * 1000,
    };
    this.durable.push(event);
    return event;
  }

  /** A frame about one call, which is how a watch hears the child moved. */
  public toolUpdate(callId: string): void {
    for (const listener of this.listeners) {
      listener({ type: "tool_update", callId, view: { title: [] } });
    }
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

/**
 * A drain of the log and the retires it triggers are only correct together:
 * split across frames, the client holds a step's durable entry and the live
 * copy it supersedes at once, and paints it twice.
 */
test("passes a batch the session framed on to the socket whole", async () => {
  const { socket, stream, connection } = build();
  await connection.attach(stream, 0);
  const sent = socket.frames.length;

  stream.drain(2, 3);

  expect(socket.frames).toHaveLength(sent + 1);
  expect(socket.seqs).toEqual([2, 3]);
  expect(connection.seq).toBe(3);
});

test("reconciles a batch that lands during the replay read", async () => {
  const { socket, stream, connection } = build();
  stream.append(2);

  const attaching = connection.attach(stream, 0);
  stream.drain(3, 4);
  await attaching;

  // Held event by event rather than frame by frame: the gate keeps the
  // durable half of what it caught, and an envelope it could not see into
  // would take those lines down with it.
  expect(socket.seqs).toEqual([2, 3, 4]);
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

let tmp: string | undefined;

/** Polls, because a drain of the child's log is a read this side did not await. */
async function until(ready: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await Bun.sleep(1);
  }
}

afterEach(async () => {
  if (tmp) {
    await rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

/**
 * A subagent's log on disk, plus the way to grow it: a watch is read while
 * the child is still writing, so a test that cannot append is only ever
 * testing the settled case.
 */
async function childLog(): Promise<{
  readonly projection: SessionProjection;
  readonly append: (role: string, text: string) => Promise<void>;
}> {
  tmp = await mkdtemp(join(tmpdir(), "pim-watch-test-"));
  const path = join(tmp, "call_1.jsonl");
  let entries = 0;
  const append = async (role: string, text: string): Promise<void> => {
    entries += 1;
    await appendFile(
      path,
      `${JSON.stringify({
        type: "message",
        id: `entry-${entries}`,
        timestamp: "2026-09-07T10:00:00.000Z",
        message: { role, content: [{ type: "text", text }] },
      })}\n`
    );
  };
  await Bun.write(path, "");
  return { projection: new SessionProjection(path, () => "/"), append };
}

/**
 * The child's transcript travels in an envelope so that nothing in it can be
 * taken for the session's own: a durable event is one with a `seq`, and the
 * child's messages have theirs.
 */
test("hands a watched child over enveloped, never in the transcript", async () => {
  const { socket, stream, connection } = build();
  const { projection, append } = await childLog();
  await append("user", "find every call site");
  await append("assistant", "three of them are in tests");
  await connection.attach(stream, 0);

  await connection.watchSubagent("call_1", projection, 0);

  expect(socket.watched).toHaveLength(1);
  expect(
    socket.watched[0]?.map((event) => "seq" in event && event.seq)
  ).toEqual([1, 2]);
  expect(socket.seqs).toEqual([]);
  expect(
    socket.events.some(
      (event) =>
        event.type === "message" && event.text === "find every call site"
    )
  ).toBe(false);
});

test("resumes a watch from `fromSeq` rather than replaying it", async () => {
  const { socket, stream, connection } = build();
  const { projection, append } = await childLog();
  await append("user", "find every call site");
  await append("assistant", "three of them are in tests");
  await connection.attach(stream, 0);

  await connection.watchSubagent("call_1", projection, 1);

  expect(
    socket.watched.flat().map((event) => ("seq" in event ? event.seq : 0))
  ).toEqual([2]);
});

/**
 * No poller: the child runs inside the parent's tool call, so the parent's
 * own frame about that call is the news that the child wrote something.
 */
test("drains the child log when the parent reports its call moved", async () => {
  const { socket, stream, connection } = build();
  const { projection, append } = await childLog();
  await append("user", "find every call site");
  await connection.attach(stream, 0);
  await connection.watchSubagent("call_1", projection, 0);

  await append("assistant", "three of them are in tests");
  // Another call's frame says nothing about this child, and is refused
  // before any read of its log is started — so there is nothing to wait for.
  stream.toolUpdate("call_other");
  expect(socket.watched).toHaveLength(1);

  stream.toolUpdate("call_1");
  await until(() => socket.watched.length === 2, "the child's second entry");

  expect(
    socket.watched[1]?.map((event) => "seq" in event && event.seq)
  ).toEqual([2]);
});

test("stops draining once the watch is dropped", async () => {
  const { socket, stream, connection } = build();
  const { projection, append } = await childLog();
  await append("user", "find every call site");
  await connection.attach(stream, 0);
  await connection.watchSubagent("call_1", projection, 0);

  connection.unwatchSubagent("call_2");
  expect(connection.watchedCallId).toBe("call_1");

  connection.unwatchSubagent("call_1");
  await append("assistant", "three of them are in tests");
  stream.toolUpdate("call_1");

  expect(connection.watchedCallId).toBeUndefined();
  expect(socket.watched).toHaveLength(1);
});

/**
 * The leak: a modal whose socket died leaves a projection holding every event
 * of that child for the life of the process, and nothing else would ever drop
 * it — the client that would have said `unwatch` is the thing that vanished.
 */
test("drops the watch when the socket closes", async () => {
  const { socket, stream, connection } = build();
  const { projection, append } = await childLog();
  await append("user", "find every call site");
  await connection.attach(stream, 0);
  await connection.watchSubagent("call_1", projection, 0);
  const sent = socket.frames.length;

  connection.close();

  expect(connection.watchedCallId).toBeUndefined();
  await append("assistant", "three of them are in tests");
  stream.toolUpdate("call_1");
  expect(socket.frames).toHaveLength(sent);
});

test("drops the watch when the client attaches elsewhere", async () => {
  const { socket, stream, connection } = build();
  const { projection, append } = await childLog();
  await append("user", "find every call site");
  await connection.attach(stream, 0);
  await connection.watchSubagent("call_1", projection, 0);
  const sent = socket.frames.length;

  await connection.attach(new FakeStream(), 0);

  expect(connection.watchedCallId).toBeUndefined();
  await append("assistant", "three of them are in tests");
  stream.toolUpdate("call_1");
  expect(socket.watched).toHaveLength(1);
  expect(socket.frames.length).toBeGreaterThan(sent);
});
