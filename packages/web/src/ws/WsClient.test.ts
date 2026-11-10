import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { join } from "node:path";
import { flush } from "solid-js";

import type { DurableEvent, ServerEvent } from "#protocol/ServerEvent";
import { SessionStore } from "../session/SessionStore";
import { toRows } from "../transcript/rows";
import {
  cutSocket,
  GatewayHarness,
  REASONING,
  REPLY,
  TOOL_PROSE,
} from "../test/gateway";
import { until } from "#core/shared/fixtures/wait";
import { WsClient, type WsClientOptions } from "./WsClient";

let harness: GatewayHarness;
let stores: SessionStore[] = [];
let recorder: FrameRecorder | undefined;
let clients: WsClient[] = [];
let restoreSocket: (() => void) | undefined;

function open(
  options: { readonly sessionId?: string; readonly cwd?: string } = {}
): SessionStore {
  const store = new SessionStore({
    url: harness.url,
    cwd: options.cwd ?? harness.tmp,
    ...(options.sessionId === undefined
      ? {}
      : { sessionId: options.sessionId }),
    retryMs: 20,
    pickerDebounceMs: 0,
  });
  stores.push(store);
  return store;
}

async function connect(
  options: { readonly sessionId?: string } = {}
): Promise<SessionStore> {
  const store = open(options);
  await store.connect();
  return store;
}

function idle(store: SessionStore): Promise<void> {
  return until(
    () => store.state.agent === "idle" && store.state.durable.length > 0,
    "the agent to settle"
  );
}

function seqs(events: readonly DurableEvent[]): readonly number[] {
  return events.map((event) => event.seq);
}

beforeEach(async () => {
  harness = new GatewayHarness();
  await harness.start();
});

afterEach(async () => {
  for (const store of stores) {
    store.dispose();
  }
  stores = [];
  for (const one of clients) {
    one.close();
  }
  clients = [];
  restoreSocket?.();
  restoreSocket = undefined;
  await recorder?.stop();
  recorder = undefined;
  await harness.stop();
});

function liveText(store: SessionStore): string {
  return store.state.live.map((message) => message.text).join("");
}

function liveTools(store: SessionStore) {
  return store.state.live.flatMap((message) => message.tools);
}

test("streams a whole turn into the timeline", async () => {
  const store = await connect();
  expect(store.state.sessionId).toBeString();

  await store.prompt("say hello with a tool");
  await until(() => liveText(store) !== "" || store.isBusy(), "streaming");
  await idle(store);

  const messages = store.state.durable.filter(
    (event) => event.type === "message"
  );
  expect(messages.map((m) => m.type === "message" && m.role)).toEqual([
    "user",
    "assistant",
    "assistant",
  ]);
  expect(
    messages.at(-1)?.type === "message" && messages.at(-1)?.type === "message"
  ).toBe(true);
  const final = messages.at(-1);
  expect(final?.type === "message" && final.text.trim()).toBe(REPLY);
  expect(
    store.state.durable.some((event) => event.type === "tool_result")
  ).toBe(true);
  expect(store.state.live).toEqual([]);
});

test("the optimistic echo is replaced by the durable user message", async () => {
  const store = await connect();

  const sent = store.prompt("say hello");
  flush();
  expect(store.state.optimistic.map((one) => one.text)).toEqual(["say hello"]);
  expect(store.trailing()).toHaveLength(1);
  await sent;

  await until(
    () => store.state.optimistic.length === 0,
    "the durable user message"
  );
  const users = store.state.durable.filter(
    (event) => event.type === "message" && event.role === "user"
  );
  expect(users).toHaveLength(1);
  expect(users[0]?.type === "message" && users[0].text).toBe("say hello");
});

// What pi is holding for the turn. Only stable while the turn is parked
// mid-stream: pi drains it at tool boundaries.
function queuedOn(store: SessionStore): readonly string[] {
  const agent = harness.registry.peek(store.state.sessionId)?.agentSession;
  return [
    ...(agent?.getSteeringMessages() ?? []),
    ...(agent?.getFollowUpMessages() ?? []),
  ];
}

// Queued rows only; the opening message clears on its own schedule.
function heldBack(store: SessionStore): readonly string[] {
  return store
    .trailing()
    .filter((one) => one.queued === true)
    .map((one) => one.text);
}

test("a message typed into a running turn steers it", async () => {
  const store = await connect();
  const release = harness.holdTurn();
  await store.prompt("hold this turn open");
  await until(() => store.isBusy(), "the turn to start");

  await store.prompt("and mention the weather");
  flush();
  expect(heldBack(store)).toEqual(["and mention the weather"]);
  await until(() => queuedOn(store).length === 1, "pi to queue the steer");
  expect(queuedOn(store)).toEqual(["and mention the weather"]);

  await store.prompt("and the tide");
  await until(
    () => queuedOn(store)[0]?.includes("tide") === true,
    "the second message to join the first"
  );
  flush();
  expect(queuedOn(store)).toEqual(["and mention the weather\n\nand the tide"]);
  expect(heldBack(store)).toEqual(["and mention the weather\n\nand the tide"]);

  release();
  await until(
    () =>
      store.state.durable.filter(
        (event) => event.type === "message" && event.role === "user"
      ).length === 2,
    "both messages to reach the log"
  );
  expect(store.state.optimistic).toEqual([]);
});

test("stopping hands the queued message back to the box it came from", async () => {
  const store = await connect();
  const release = harness.holdTurn();
  await store.prompt("hold this turn open");
  await until(() => store.isBusy(), "the turn to start");
  await store.prompt("never mind");
  await until(() => queuedOn(store).length === 1, "pi to queue the steer");

  const restored = await store.cancel();
  release();

  expect(restored).toBe("never mind");
  flush();
  expect(store.state.optimistic.map((one) => one.text)).not.toContain(
    "never mind"
  );
});

test("taking the queued message back leaves the turn running", async () => {
  const store = await connect();
  const release = harness.holdTurn();
  await store.prompt("hold this turn open");
  await until(() => store.isBusy(), "the turn to start");
  await store.prompt("on second thoughts");
  await until(() => queuedOn(store).length === 1, "pi to queue the steer");

  const restored = await store.dequeue();

  expect(restored).toBe("on second thoughts");
  expect(store.isBusy()).toBe(true);
  expect(queuedOn(store)).toEqual([]);
  flush();
  expect(heldBack(store)).toEqual([]);
  release();
});

function toolRows(store: SessionStore): readonly string[] {
  return toRows(store.state.durable, store.trailing(), store.state.live)
    .filter((row) => row.kind === "tool")
    .map((row) => row.id);
}

test("in-flight tool rows merge with the durable ones on callId", async () => {
  const store = await connect();
  await store.prompt("use a tool please");
  await until(() => toolRows(store).length > 0, "a tool row");
  expect(new Set(toolRows(store)).size).toBe(toolRows(store).length);

  await idle(store);
  expect(store.state.live).toEqual([]);
  expect(toolRows(store)).toHaveLength(1);
});

test("a finished step goes durable while the next one is still live", async () => {
  const store = await connect();
  const release = harness.holdTurn();
  await store.prompt("use a tool please");
  // The written step arrives via JSONL, which lags the live stream, so wait for both.
  await until(
    () =>
      liveText(store).trim() !== "" &&
      store.state.durable.some((event) => event.type === "tool_result"),
    "the second step to stream, and the first to be written"
  );

  const [step] = store.state.durable.filter(
    (event) => event.type === "message" && event.role === "assistant"
  );
  expect(step?.type === "message" && step.text.trim()).toBe(TOOL_PROSE);
  expect(step?.type === "message" && step.thinking?.trim()).toBe(REASONING);
  expect(step?.type === "message" && step.toolCalls?.length).toBe(1);
  expect(store.state.live).toHaveLength(1);
  expect(liveTools(store)).toEqual([]);

  release();
  await idle(store);
  expect(store.state.live).toEqual([]);
});

test("loses and duplicates nothing across a gateway restart", async () => {
  const store = await connect();
  const sessionId = store.state.sessionId;

  await store.prompt("say hello");
  await idle(store);
  expect(store.client.seq).toBeGreaterThan(0);

  const release = harness.holdTurn();
  await store.prompt("say hello again");
  await until(() => liveText(store) !== "", "the first delta");
  const before = [...store.state.durable];

  await harness.dropGateway();
  await until(
    () => store.state.connection === "reconnecting",
    "the client to notice"
  );
  harness.startGateway();
  await until(() => store.state.connection === "open", "the reconnect");
  release();
  await idle(store);

  const after = store.state.durable;
  expect(seqs(after)).toEqual([...new Set(seqs(after))]);
  expect(seqs(after)).toEqual([...seqs(after)].sort((a, b) => a - b));
  expect(after.slice(0, before.length)).toEqual(before);
  expect(store.state.sessionId).toBe(sessionId);

  const final = after.filter((event) => event.type === "message").at(-1);
  expect(final?.type === "message" && final.text.trim()).toBe(REPLY);

  const fresh = await connect({ sessionId });
  await until(
    () => fresh.state.durable.length >= after.length,
    "the fresh replay"
  );
  expect(fresh.state.durable).toEqual(after);
});

test("re-attaching does not replay the in-flight text twice", async () => {
  const release = harness.holdTurn();
  const store = await connect();
  await store.prompt("say hello");
  // Wait for the whole reply so the text at the drop is deterministic.
  await until(
    () => liveText(store).trim() === REPLY,
    "the held step to stream its reply"
  );
  const streamed = liveText(store);

  // Cut the socket, not the server, so the resume comes from the in-flight turn.
  cutSocket(store.client);
  await until(() => store.state.connection === "reconnecting", "the drop");
  await until(() => store.state.connection === "open", "the reconnect");
  await until(() => liveText(store) !== "", "the coalesced snapshot");

  expect(liveText(store)).toBe(streamed);
  release();
  await idle(store);
});

test("the file picker is answered by the server and completes a token", async () => {
  await Bun.write(`${harness.tmp}/greeter.ts`, "export const x = 1;\n");
  const store = await connect();

  const items = await store.files.rank("greeter", { limit: 10 });
  expect(items?.length).toBeGreaterThan(0);
  expect(items?.[0]?.value).toContain("greeter.ts");

  const direct = await store.pickFiles("greeter", 10);
  expect(direct.map((item) => item.value)).toEqual(
    (items ?? []).map((item) => item.value)
  );
});

test("switching sessions swaps the log and keeps the socket", async () => {
  const store = await connect();
  const first = store.state.sessionId;
  await store.prompt("say hello");
  await idle(store);
  const firstLog = [...store.state.durable];

  await store.newSession();
  await until(
    () => store.state.sessionId !== "" && store.state.sessionId !== first,
    "a new session"
  );
  expect(store.state.durable).toEqual([]);
  expect(store.client.seq).toBe(0);
  const second = store.state.sessionId;

  const { sessions: listed } = await store.listSessions();
  expect(listed.map((row) => row.sessionId)).toContain(first);
  expect(listed.every((row) => row.cwd === harness.tmp)).toBe(true);
  expect(second).not.toBe(first);

  await store.switchTo(first);
  await until(
    () => store.state.durable.length >= firstLog.length,
    "the first session's log"
  );
  expect(store.state.sessionId).toBe(first);
  expect(store.state.durable).toEqual(firstLog);
});

test("a turn is marked on the list of a client that is reading elsewhere", async () => {
  const worker = await connect();
  const sessionId = worker.state.sessionId;
  await worker.prompt("say hello");
  await idle(worker);

  const watcher = await connect();
  expect(watcher.state.sessionId).not.toBe(sessionId);
  await watcher.listSessions();
  expect(watcher.isRunning(sessionId)).toBe(false);

  const release = harness.holdTurn();
  await worker.prompt("say hello again");
  await until(() => watcher.isRunning(sessionId), "the other session to work");
  release();
  await until(() => !watcher.isRunning(sessionId), "the other session to stop");
});

test("an upload reaches the transcript as a file, not as a path", async () => {
  const store = await connect();
  const stored = await store.attachFile(
    new File(["hello"], "notes.txt", { type: "text/plain" })
  );

  expect(stored.url).toStartWith("http");
  expect(store.attachmentsOf(store.state.sessionId)).toEqual([stored]);
  await store.prompt("look at this");
  await until(
    () => store.state.durable.some((event) => event.type === "message"),
    "the durable user message"
  );

  const said = store.state.durable.find(
    (event) => event.type === "message" && event.role === "user"
  );
  expect(said?.type === "message" && said.text).toBe("look at this");
  expect(said?.type === "message" && said.attachments).toEqual([
    { name: "notes.txt", url: stored.url, isImage: false },
  ]);
  expect(JSON.stringify(store.state.durable)).not.toContain(harness.tmp);
  expect(store.attachmentsOf(store.state.sessionId)).toEqual([]);

  const fetched = await fetch(stored.url);
  expect(await fetched.text()).toBe("hello");
});

test("the model catalogue is asked for once and switching it lands on state", async () => {
  const store = await connect();

  const first = await store.listModels();
  expect(first.models).toEqual([
    {
      id: "test/echo",
      label: "echo",
      provider: "test",
      thinkingLevels: ["off"],
    },
  ]);
  expect(first.thinkingLevels).toBeArray();
  expect(await store.listModels()).toBe(first);

  await store.setModel("test/echo");
  await until(() => store.state.model === "test/echo", "the model on state");
});

test("a new chat is the browser's alone until pi writes its first line", async () => {
  const store = await connect();
  const first = store.state.sessionId;
  expect(store.unwrittenSummary()).toBeUndefined();
  expect(
    (await store.listSessions()).sessions.map((row) => row.sessionId)
  ).not.toContain(first);

  store.setDraftText("say hello");
  flush();
  expect(store.unwrittenSummary()).toEqual({
    sessionId: first,
    cwd: harness.tmp,
  });
  expect(store.localTitle(first)).toBe("say hello");

  await store.newSession();
  expect(store.state.sessionId).toBe(first);

  await store.prompt("say hello");
  flush();
  expect(store.draftText(first)).toBe("");
  expect(store.unwrittenSummary()).toEqual({
    sessionId: first,
    cwd: harness.tmp,
  });
  expect(store.localTitle(first)).toBe("say hello");
  await idle(store);

  const { sessions: listed } = await store.listSessions();
  flush();
  expect(listed.map((row) => row.sessionId)).toContain(first);
  expect(store.unwrittenSummary()).toBeUndefined();
  expect(listed.find((row) => row.sessionId === first)?.title).toBe(
    "say hello"
  );

  await store.newSession();
  await until(() => store.state.sessionId !== first, "a second session");
  expect(store.state.unwritten?.sessionId).toBe(store.state.sessionId);
});

test("a session sent to and left keeps its name against the real listing", async () => {
  const store = await connect();
  const first = store.state.sessionId;

  await store.prompt("say hello");
  flush();
  await store.newSession();
  await until(() => store.state.sessionId !== first, "a second session");
  flush();

  const { sessions: listed } = await store.listSessions();
  flush();
  const row = listed.find((entry) => entry.sessionId === first);
  expect(row?.title ?? store.localTitle(first)).toBe("say hello");
});

test("`/clear` opens a session beside the one it was typed into", async () => {
  const store = await connect();
  const first = store.state.sessionId;
  await store.prompt("say hello");
  await idle(store);

  await store.prompt("/clear");
  await until(() => store.state.sessionId !== first, "the cleared session");
  flush();

  expect(store.state.durable).toEqual([]);
  expect(store.state.cwd).toBe(harness.tmp);
  const { sessions: listed } = await store.listSessions();
  expect(listed.find((row) => row.sessionId === first)?.title).toBe(
    "say hello"
  );
  expect(store.draftText(first)).toBe("");
});

test("the command picker merges `/clear` into the server's own rows", async () => {
  await Bun.write(
    join(harness.tmp, ".pi", "skills", "deploy", "SKILL.md"),
    "---\nname: deploy\ndescription: Ship the thing.\n---\n\nbody\n"
  );
  const store = await connect();

  const all = await store.pickCommands("");

  expect(all.map((item) => item.value)).toContain("/skill:deploy");
  expect(all.map((item) => item.value)).toContain("/clear");
  expect((await store.pickCommands("cle"))[0]?.value).toBe("/clear");
});

test("a directory that cannot be opened leaves the session being read alone", async () => {
  const store = await connect();
  const first = store.state.sessionId;
  store.setDraftText("half a thought");

  await expect(
    store.openDirectory(join(harness.tmp, "no-such-place"))
  ).rejects.toThrow();
  flush();

  expect(store.state.sessionId).toBe(first);
  expect(store.state.error).toContain("does not exist");
  expect(store.draftText(first)).toBe("half a thought");

  await store.prompt("say hello");
  await idle(store);
  expect(store.state.durable.length).toBeGreaterThan(0);
});

type Frame = Record<string, unknown> & {
  readonly type: string;
  readonly id: string;
};

// Records every frame. The real gateway answers the same whether a field
// arrived or not, so it cannot test what a client sends.
class FrameRecorder {
  private readonly frames: Frame[] = [];
  private readonly sockets = new Set<ServerWebSocket<unknown>>();
  private readonly server: ReturnType<typeof Bun.serve>;
  // Frames sent before the next `attached`.
  public readonly ahead: ServerEvent[] = [];
  /** Records frames but answers none, like a socket the network dropped silently. */
  public muted = false;
  public refusing = false;

  public constructor() {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: (request, self) =>
        self.upgrade(request, { data: undefined })
          ? undefined
          : new Response("no", { status: 400 }),
      websocket: {
        open: (socket) => {
          this.sockets.add(socket);
        },
        close: (socket) => {
          this.sockets.delete(socket);
        },
        message: (socket, raw) => {
          this.answer(socket, String(raw));
        },
      },
    });
  }

  public get url(): string {
    return `ws://127.0.0.1:${String(this.server.port)}`;
  }

  public get connected(): number {
    return this.sockets.size;
  }

  public of(type: string): readonly Frame[] {
    return this.frames.filter((frame) => frame.type === type);
  }

  // Closes the client's sockets without stopping the server.
  public drop(): void {
    for (const socket of this.sockets) {
      socket.close();
    }
  }

  public async stop(): Promise<void> {
    await this.server.stop(true);
  }

  private answer(socket: ServerWebSocket<unknown>, raw: string): void {
    const frame = JSON.parse(raw) as Frame;
    this.frames.push(frame);
    if (this.muted) {
      return;
    }
    if (frame.type === "attach" && this.refusing) {
      socket.send(
        JSON.stringify({
          type: "response",
          id: frame.id,
          success: false,
          error: "no such session",
        })
      );
      return;
    }
    if (frame.type === "attach") {
      for (const event of this.ahead.splice(0)) {
        socket.send(JSON.stringify(event));
      }
      socket.send(
        JSON.stringify({
          type: "attached",
          sessionId: "s1",
          cwd: "/repo",
          head: 0,
          pimVersion: "1.2.3",
          piVersion: "0.9.0",
        })
      );
    }
    socket.send(
      JSON.stringify({ type: "response", id: frame.id, success: true })
    );
  }
}

function record(): FrameRecorder {
  recorder = new FrameRecorder();
  return recorder;
}

function client(
  server: FrameRecorder,
  onEvent: (event: ServerEvent) => void = () => {},
  options: Partial<WsClientOptions> = {}
): WsClient {
  const one = new WsClient({
    url: server.url,
    sessionId: "s1",
    onEvent,
    retryMs: 1,
    ...options,
  });
  clients.push(one);
  return one;
}

test("a broadcast that lands inside the attach window is not dropped", async () => {
  const server = record();
  const seen: ServerEvent[] = [];
  const one = client(server, (event) => {
    seen.push(event);
  });
  server.ahead.push(
    { type: "session_meta", sessionId: "s2", archived: true },
    { type: "project_meta", cwd: "/repo", pinned: true },
    { type: "session_read", sessionId: "s2" },
    { type: "sessions_changed" },
    { type: "pins_changed", order: ["/repo"] },
    { type: "session_activity", sessionId: "s2", status: "thinking" },
    { type: "update_state", phase: "step", label: "fetching" },
    { type: "error", message: "malformed frame" }
  );

  await one.connect();

  expect(seen.map((event) => event.type)).toEqual([
    "session_meta",
    "project_meta",
    "session_read",
    "sessions_changed",
    "pins_changed",
    "session_activity",
    "update_state",
    "error",
    "attached",
  ]);
});

test("the attached session's own frames wait for the attach to settle", async () => {
  const server = record();
  const seen: ServerEvent[] = [];
  const one = client(server, (event) => {
    seen.push(event);
  });
  server.ahead.push(
    { type: "message_start", role: "assistant", messageId: "m1" },
    { type: "text_delta", messageId: "m1", delta: "stale" },
    {
      type: "turn_end",
      stats: { inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1 },
    },
    { type: "picker_invalidate", scope: "files", cwd: "/elsewhere" }
  );

  await one.connect();

  expect(seen.map((event) => event.type)).toEqual(["attached"]);
});

test("a hidden tab stays hidden across a reconnect", async () => {
  const server = record();
  const one = client(server);
  await one.connect();
  expect(server.of("attach").at(-1)?.attentive).toBe(true);

  one.setAttention(false);
  await until(
    () => server.of("attention").length === 1,
    "the attention command"
  );
  expect(server.of("attention")[0]?.value).toBe(false);

  server.drop();
  await until(() => server.of("attach").length === 2, "the reconnect");
  expect(server.of("attach").at(-1)?.attentive).toBe(false);
});

test("attention is declared on change and not repeated", async () => {
  const server = record();
  const one = client(server);
  await one.connect();

  one.setAttention(false);
  one.setAttention(false);
  one.setAttention(true);
  await until(() => server.of("attention").length === 2, "both declarations");

  expect(server.of("attention").map((frame) => frame.value)).toEqual([
    false,
    true,
  ]);
  expect(one.attentive).toBe(true);
});

test("attention declared while the socket is down rides the next attach", async () => {
  const server = record();
  const one = client(server);

  one.setAttention(false);
  await one.connect();

  expect(server.of("attach").at(-1)?.attentive).toBe(false);
  expect(server.of("attention")).toEqual([]);
});

test("a connect that never answers is abandoned and retried", async () => {
  let dials = 0;
  const silent = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open: () => {
        dials++;
      },
      data: () => undefined,
    },
  });
  const one = new WsClient({
    url: `ws://127.0.0.1:${String(silent.port)}`,
    onEvent: () => undefined,
    retryMs: 1,
    timeoutMs: 20,
  });
  clients.push(one);
  try {
    await expect(one.connect()).rejects.toThrow("could not connect");
    await until(() => dials >= 2, "a second dial");
    expect(one.status).toBe("reconnecting");
  } finally {
    silent.stop(true);
  }
});

test("a dial that times out is redialled at once, and each miss waits longer", async () => {
  const dials: number[] = [];
  const silent = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open: () => {
        dials.push(performance.now());
      },
      data: () => undefined,
    },
  });
  const one = new WsClient({
    url: `ws://127.0.0.1:${String(silent.port)}`,
    onEvent: () => undefined,
    retryMs: 300,
    timeoutMs: 300,
  });
  clients.push(one);
  try {
    void one.connect().catch(() => undefined);
    await until(() => dials.length >= 4, "four dials");
    const gaps = dials.slice(1).map((at, i) => at - (dials[i] ?? 0));

    // Timed out after 300ms, then no retry wait on top.
    expect(gaps[0]).toBeLessThan(500);
    expect(gaps[1]).toBeGreaterThanOrEqual(550);
    expect(gaps[2]).toBeGreaterThanOrEqual(1100);
  } finally {
    silent.stop(true);
  }
});

test("waking skips the wait for the next retry", async () => {
  const server = record();
  const one = new WsClient({
    url: server.url,
    sessionId: "s1",
    onEvent: () => undefined,
    retryMs: 60_000,
  });
  clients.push(one);
  await one.connect();

  server.drop();
  await until(() => one.status === "reconnecting", "the drop");
  one.wake();

  await until(() => server.of("attach").length === 2, "the reconnect");
  expect(one.status).toBe("open");
});

test("waking a live client checks the socket and keeps it", async () => {
  const server = record();
  const one = client(server, () => {}, { timeoutMs: 50 });
  await one.connect();

  one.wake();
  await until(() => server.of("attention").length === 1, "the probe");
  await Bun.sleep(100);

  expect(server.of("attention")[0]?.value).toBe(true);
  expect(server.of("attach")).toHaveLength(1);
  expect(one.status).toBe("open");
});

/** A browser that loses `close`, as a suspended mobile page can. Counts every dial. */
function deafToClose(): { readonly dials: () => number } {
  const Real = globalThis.WebSocket;
  let dials = 0;
  class Deaf extends Real {
    public constructor(url: string | URL) {
      super(url);
      dials++;
    }
    public override addEventListener(
      ...args: Parameters<WebSocket["addEventListener"]>
    ): void {
      if (args[0] !== "close") {
        super.addEventListener(...args);
      }
    }
  }
  globalThis.WebSocket = Deaf as typeof WebSocket;
  restoreSocket = () => {
    globalThis.WebSocket = Real;
  };
  return { dials: () => dials };
}

test("waking replaces a socket that died without a close event", async () => {
  const server = record();
  deafToClose();
  const one = client(server, () => {}, { timeoutMs: 50 });
  await one.connect();

  server.drop();
  await until(() => server.connected === 0, "the drop");
  expect(one.status).toBe("open");
  one.wake();

  await until(() => server.of("attach").length === 2, "the reconnect");
  await until(() => one.status === "open", "the reopen");
});

test("a dial that errors without a close event is still retried", async () => {
  const free = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data: () => undefined },
  });
  const port = free.port;
  free.stop(true);
  const { dials } = deafToClose();
  const one = new WsClient({
    url: `ws://127.0.0.1:${String(port)}`,
    onEvent: () => undefined,
    retryMs: 1,
  });
  clients.push(one);

  await expect(one.connect()).rejects.toThrow("could not connect");
  await until(() => dials() >= 3, "more dials");
  expect(one.status).toBe("reconnecting");
});

test("waking drops an open socket that no longer answers", async () => {
  const server = record();
  const one = client(server, () => {}, { timeoutMs: 50 });
  await one.connect();

  server.muted = true;
  one.wake();
  await until(() => server.of("attention").length === 1, "the probe");
  server.muted = false;

  await until(() => server.of("attach").length === 2, "the reconnect");
  await until(() => one.status === "open", "the reopen");
});

test("a reconnect the server refuses is handed back", async () => {
  const server = record();
  const refused: (string | undefined)[] = [];
  const one = client(server, () => {}, {
    onRefused: (response) => {
      refused.push(response.error);
    },
  });
  await one.connect();

  server.refusing = true;
  server.drop();

  await until(() => refused.length === 1, "the refusal");
  expect(refused).toEqual(["no such session"]);
  expect(one.status).toBe("open");
});

test("a reconnect whose attach is never answered is dropped and redialled", async () => {
  const server = record();
  const one = client(server, () => {}, { timeoutMs: 20 });
  await one.connect();

  server.muted = true;
  server.drop();
  await until(() => server.of("attach").length === 2, "the silent attach");
  await until(() => server.of("attach").length === 3, "the redial");
  server.muted = false;

  await until(() => server.of("attach").length === 4, "the answered attach");
  await until(() => one.status === "open", "the reopen");
  await Bun.sleep(150);
  expect(server.of("attach")).toHaveLength(4);
});

test("waking redials a dial that began before the sleep", async () => {
  const dials: number[] = [];
  const silent = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open: () => {
        dials.push(performance.now());
      },
      data: () => undefined,
    },
  });
  const one = new WsClient({
    url: `ws://127.0.0.1:${String(silent.port)}`,
    onEvent: () => undefined,
    retryMs: 1,
    timeoutMs: 150,
  });
  clients.push(one);
  try {
    void one.connect().catch(() => undefined);
    // The third dial has 600ms to answer.
    await until(() => dials.length === 3, "three dials");
    one.wake();
    await Bun.sleep(200);
    expect(dials).toHaveLength(3);

    one.wake();
    await until(() => dials.length === 4, "the redial");
    expect((dials[3] ?? 0) - (dials[2] ?? 0)).toBeLessThan(450);
  } finally {
    silent.stop(true);
  }
});
