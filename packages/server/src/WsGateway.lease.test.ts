import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { SessionRegistry } from "#core/session/SessionRegistry";
import { SessionLease, type LeaseHandle } from "#core/session/SessionLease";
import type { ServerEvent } from "#protocol/ServerEvent";
import { ProbeClient } from "./ProbeClient";
import { WsGateway } from "./WsGateway";

const REPLY = "hello from the gateway";

let tmp: string;
let agentDir: string;
let previousAgentDir: string | undefined;
let modelServer: ReturnType<typeof Bun.serve> | undefined;
let registry: SessionRegistry;
let gateway: WsGateway;
let probes: ProbeClient[] = [];
let leases: LeaseHandle[] = [];

function chunk(delta: Record<string, unknown>, finish?: string): string {
  return `data: ${JSON.stringify({
    id: "1",
    object: "chat.completion.chunk",
    created: 0,
    model: "echo",
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  })}\n\n`;
}

function startModelServer(): void {
  modelServer = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encode = (text: string) =>
            controller.enqueue(Buffer.from(text));
          encode(chunk({ role: "assistant", content: "" }));
          encode(chunk({ content: REPLY }));
          encode(chunk({}, "stop"));
          encode("data: [DONE]\n\n");
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
}

async function connect(): Promise<ProbeClient> {
  const probe = new ProbeClient({ url: gateway.url, cwd: tmp });
  probes.push(probe);
  expect((await probe.connect()).success).toBe(true);
  return probe;
}

function idle(probe: ProbeClient, from: number): Promise<ServerEvent> {
  return probe.waitFor(
    (event) => event.type === "session_state" && event.status === "idle",
    { from, timeoutMs: 20_000 }
  );
}

/**
 * The lease this process takes as the terminal would: the record names another
 * frontend, so the daemon reading it sees a holder that is not itself. Waits
 * for it the way the terminal does, because the daemon gives its own back a
 * moment after the turn it ran reads as settled.
 */
async function takeAsTui(sessionPath: string): Promise<LeaseHandle> {
  const result = await SessionLease.waitFor(sessionPath, "tui", {
    pollMs: 1,
    timeoutMs: 20_000,
  });
  if (!result.ok) {
    throw new Error("the lease was already held");
  }
  leases.push(result.handle);
  return result.handle;
}

function pathOf(sessionId: string): string {
  const path = registry.peek(sessionId)?.settings.sessionPath;
  if (path === undefined) {
    throw new Error(`session ${sessionId} has no file yet`);
  }
  return path;
}

/** One line, as the terminal's pi would have appended it: this process runs no agent for it and hears no event about it. */
async function appendEntry(
  path: string,
  id: string,
  message: Record<string, unknown>
): Promise<void> {
  const entry = {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message,
  };
  await Bun.write(
    path,
    `${await Bun.file(path).text()}${JSON.stringify(entry)}\n`
  );
}

/** A whole session file written by a process this server knows nothing about. */
async function writeForeignSession(id: string, cwd: string): Promise<string> {
  const dir = join(agentDir, "sessions", "foreign");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  await Bun.write(
    path,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp: new Date().toISOString(),
      cwd,
    })}\n`
  );
  return path;
}

function heldState(probe: ProbeClient, from: number): Promise<ServerEvent> {
  return probe.waitFor(
    (event) => event.type === "session_state" && !event.writable,
    { from, timeoutMs: 20_000 }
  );
}

function freeState(probe: ProbeClient, from: number): Promise<ServerEvent> {
  return probe.waitFor(
    (event) => event.type === "session_state" && event.writable,
    { from, timeoutMs: 20_000 }
  );
}

async function until(ready: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await Bun.sleep(1);
  }
}

/** Every user message the log has, in the order pi wrote it. */
function said(probe: ProbeClient): readonly string[] {
  return probe.events.flatMap((event) =>
    event.type === "message" && event.role === "user" ? [event.text] : []
  );
}

/** Every assistant message the log has, in the order pi wrote it. */
function replied(probe: ProbeClient): readonly string[] {
  return probe.events.flatMap((event) =>
    event.type === "message" && event.role === "assistant" ? [event.text] : []
  );
}

beforeEach(async () => {
  startModelServer();
  tmp = await mkdtemp(join(tmpdir(), "pim-lease-test-"));
  agentDir = join(tmp, "agent");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await Bun.write(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        test: {
          baseUrl: `http://localhost:${modelServer?.port}/v1`,
          api: "openai-completions",
          apiKey: "test-key",
          models: [{ id: "echo", maxTokens: 1024, contextWindow: 8192 }],
        },
      },
    })
  );
  registry = new SessionRegistry({
    defaults: { cwd: tmp, model: "test/echo" },
    agentDir,
  });
  await registry.init();
  gateway = new WsGateway({
    registry,
    port: 0,
    readCursorsPath: join(tmp, "read.json"),
  });
  gateway.start();
});

afterEach(async () => {
  for (const handle of leases) {
    await handle.release();
  }
  leases = [];
  for (const probe of probes) {
    probe.close();
  }
  probes = [];
  await gateway.stop();
  await registry.disposeAll();
  await modelServer?.stop(true);
  modelServer = undefined;
  if (previousAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  await rm(tmp, { recursive: true, force: true });
});

/**
 * The session is idle either way, so nothing about the agent says the terminal
 * has it: only the lease file does, and a client is told without asking.
 */
test("says a foreign lease has the session, and gives it back on release", async () => {
  const probe = await connect();
  const first = probe.events.length;
  await probe.prompt("say hello");
  const settled = await idle(probe, first);
  expect(settled.type === "session_state" && settled.writable).toBe(true);
  expect(settled.type === "session_state" && settled.heldBy).toBeUndefined();

  const path = pathOf(probe.sessionId!);
  const mark = probe.events.length;
  const lease = await takeAsTui(path);

  const held = await heldState(probe, mark);
  expect(held.type === "session_state" && held.heldBy).toEqual({
    frontend: "tui",
    pid: process.pid,
  });
  // The agent is doing nothing; unwritable is about the file, not the turn.
  expect(held.type === "session_state" && held.status).toBe("idle");

  const released = probe.events.length;
  await lease.release();
  const free = await freeState(probe, released);
  expect(free.type === "session_state" && free.heldBy).toBeUndefined();
});

/**
 * `writable` is an affordance, never the enforcement: a client that ignores it
 * waits for the lease inside the server and its message lands whole,
 * afterwards, in one linear conversation.
 */
test("holds a message sent anyway until the lease comes free", async () => {
  const probe = await connect();
  const first = probe.events.length;
  await probe.prompt("say hello");
  await idle(probe, first);

  const sessionId = probe.sessionId!;
  const host = registry.peek(sessionId)!;
  // Marked before the lease moves: taking it pushes a `session_state` of its
  // own, and `waitFor` awaits enough for that push to land while it is still
  // running. A mark taken afterwards misses it, and nothing pushes it again —
  // the daemon parking behind the same holder renders the very same state.
  const mark = probe.events.length;
  const lease = await takeAsTui(pathOf(sessionId));

  await probe.prompt("say hello again");
  await heldState(probe, mark);
  // The daemon asked for the lease and was refused, so the turn is parked
  // rather than running against a file the terminal is holding.
  await until(
    () => !host.leaseState.writable,
    "the daemon to park behind the lease"
  );
  expect(host.isStreaming).toBe(false);
  expect(said(probe)).toEqual(["say hello"]);

  await lease.release();
  // Un-greying is a `session_state` of its own, so the reply is what to wait
  // on: an idle state arrives the moment the lease frees, before the turn runs.
  await until(() => replied(probe).length === 2, "the parked turn to land");
  expect(said(probe)).toEqual(["say hello", "say hello again"]);
  expect(replied(probe).map((text) => text.trim())).toEqual([REPLY, REPLY]);
});

/**
 * The turn belongs to another process, so no agent event fires here and the
 * file is the only witness. It has to reach the open thread as it is written,
 * rather than the next time the client reattaches.
 */
test("carries a turn the terminal wrote into a thread already open", async () => {
  const probe = await connect();
  const first = probe.events.length;
  await probe.prompt("say hello");
  await idle(probe, first);

  const path = pathOf(probe.sessionId!);
  const lease = await takeAsTui(path);
  await appendEntry(path, "u-tui", {
    role: "user",
    content: [{ type: "text", text: "typed in the terminal" }],
  });
  await until(
    () => said(probe).includes("typed in the terminal"),
    "the terminal's message"
  );

  await appendEntry(path, "a-tui", {
    role: "assistant",
    content: [{ type: "text", text: "answered in the terminal" }],
  });
  await until(
    () => replied(probe).includes("answered in the terminal"),
    "the terminal's reply"
  );
  await lease.release();

  // One linear conversation, each line exactly once.
  expect(said(probe)).toEqual(["say hello", "typed in the terminal"]);
  expect(replied(probe).map((text) => text.trim())).toEqual([
    REPLY,
    "answered in the terminal",
  ]);
});

/**
 * A session the terminal starts is a file this server never hears about. The
 * list has to learn of it on its own: a user who has to click around to see
 * their new session is a user who thinks it was lost.
 */
test("tells clients about a session another process started", async () => {
  const probe = await connect();
  const mark = probe.events.length;
  const id = "5f0f8ab6-0000-4000-8000-0000000f0001";
  await writeForeignSession(id, tmp);

  await probe.waitFor((event) => event.type === "sessions_changed", {
    from: mark,
    timeoutMs: 20_000,
  });
  const listed = await probe.listSessions();
  expect(listed.map((session) => session.sessionId)).toContain(id);
});
