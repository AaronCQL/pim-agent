import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { SessionRegistry } from "#core/session/SessionRegistry";
import { SessionLease, type LeaseHandle } from "#core/session/SessionLease";
import type { ServerEvent } from "#protocol/ServerEvent";
import { ProbeClient } from "./ProbeClient";
import { WsGateway } from "./WsGateway";
import { until } from "#core/shared/fixtures/wait";

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

/** Waits for the turn to end; see the twin in `WsGateway.test.ts`. */
async function idle(probe: ProbeClient, from: number): Promise<ServerEvent> {
  let cursor = from;
  for (;;) {
    const event = await probe.waitFor(
      (candidate) =>
        candidate.type === "session_state" && candidate.status === "idle",
      { from: cursor, timeoutMs: 20_000 }
    );
    const host = registry.peek(probe.sessionId ?? "");
    if (host === undefined || host.status === "idle") {
      return event;
    }
    cursor = probe.events.length;
  }
}

/** Takes the lease as the terminal would, so the daemon sees a foreign holder. */
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

/** Appends a line as the terminal's pi would; this process hears no agent event for it. */
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

/** Writes a whole session file from "another process", opening message included. */
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
  await appendEntry(path, id, {
    role: "user",
    content: [{ type: "text", text: "say hello" }],
  });
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

function said(probe: ProbeClient): readonly string[] {
  return probe.events.flatMap((event) =>
    event.type === "message" && event.role === "user" ? [event.text] : []
  );
}

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
  await mkdir(join(agentDir, "sessions"), { recursive: true });
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
    sessionMetaPath: join(tmp, "sessions.json"),
    // Too slow to mask a missed file-watch event.
    pollMs: 60_000,
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
  // Unwritable is about the file, not the turn.
  expect(held.type === "session_state" && held.status).toBe("idle");

  const released = probe.events.length;
  await lease.release();
  const free = await freeState(probe, released);
  expect(free.type === "session_state" && free.heldBy).toBeUndefined();
});

test("holds a message sent anyway until the lease comes free", async () => {
  const probe = await connect();
  const first = probe.events.length;
  await probe.prompt("say hello");
  await idle(probe, first);

  const sessionId = probe.sessionId!;
  const host = registry.peek(sessionId)!;
  // Mark before taking the lease, or its `session_state` push is missed.
  const mark = probe.events.length;
  const lease = await takeAsTui(pathOf(sessionId));

  await probe.prompt("say hello again");
  await heldState(probe, mark);
  // The daemon's turn is parked behind the foreign lease.
  await until(
    () => !host.leaseState.writable,
    "the daemon to park behind the lease"
  );
  expect(host.isStreaming).toBe(false);
  expect(said(probe)).toEqual(["say hello"]);

  await lease.release();
  // Wait on the reply: an idle state arrives before the turn runs.
  await until(() => replied(probe).length === 2, "the parked turn to land");
  expect(said(probe)).toEqual(["say hello", "say hello again"]);
  expect(replied(probe).map((text) => text.trim())).toEqual([REPLY, REPLY]);
});

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

  // Each line exactly once.
  expect(said(probe)).toEqual(["say hello", "typed in the terminal"]);
  expect(replied(probe).map((text) => text.trim())).toEqual([
    REPLY,
    "answered in the terminal",
  ]);
});

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
