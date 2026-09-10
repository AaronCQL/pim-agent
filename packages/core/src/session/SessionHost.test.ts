import {
  ModelRegistry,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import { EventLog } from "./EventLog";
import { SessionHost, type SessionHostDeps } from "./SessionHost";
import { SessionLease } from "./SessionLease";
import { SessionRegistry } from "./SessionRegistry";

const MODEL_ID = "test/echo";

let tmp: string;
let agentDir: string;
let server: ReturnType<typeof Bun.serve> | undefined;
let hosts: SessionHost[] = [];

/** Resolves once the model server has been asked for a completion. */
let requested: () => void;
let requestSeen: Promise<void>;

/**
 * Yields between chunks so the deltas arrive as a stream rather than one
 * write. Duration is irrelevant: a test that has to look at a turn while it is
 * still open holds it open with `holdTurn` instead of racing a sleep.
 */
const TOKEN_DELAY_MS = 1;

/** Set by `holdTurn` to stall the reply just before it finishes. */
let gate: Promise<void> | undefined;
let releaseGate: (() => void) | undefined;

function holdTurn(): () => void {
  gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  return () => {
    gate = undefined;
    releaseGate?.();
    releaseGate = undefined;
  };
}

/**
 * Polls a condition rather than sleeping long enough that it is probably true.
 * The deadline is well inside bun's per-test one so a stuck wait says which.
 */
async function until(ready: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await Bun.sleep(1);
  }
}

function mainPath(): string {
  return join(tmp, "sessions", "main.jsonl");
}

async function leaseExists(sessionPath = mainPath()): Promise<boolean> {
  return await Bun.file(SessionLease.pathFor(sessionPath)).exists();
}

async function roles(sessionPath = mainPath()): Promise<readonly string[]> {
  const entries = await new EventLog(sessionPath).read();
  return entries.flatMap((e) =>
    e.entry.type === "message" ? [e.entry.message.role] : []
  );
}

/** The line a `pi` that never took the lease leaves behind: a child of whatever leaf it read. */
async function appendUnleased(text: string): Promise<void> {
  const entries = await new EventLog(mainPath()).read();
  await appendFile(
    mainPath(),
    `${JSON.stringify({
      type: "message",
      id: "unleased",
      parentId: entries.at(-1)?.entry.id ?? null,
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
      },
    })}\n`
  );
}

function chunk(delta: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    id: "1",
    object: "chat.completion.chunk",
    created: 0,
    model: "echo",
    choices: [{ index: 0, delta, finish_reason: null }],
  })}\n\n`;
}

/**
 * An OpenAI-compatible endpoint that streams a fixed reply one token at a
 * time, stalling before the final chunk while a test holds `gate` so the turn
 * can be inspected or aborted mid-flight.
 */
function startModelServer(): void {
  server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      requested();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encode = (s: string) => controller.enqueue(Buffer.from(s));
          encode(chunk({ role: "assistant", content: "" }));
          for (const word of ["hello", " ", "from", " ", "the", " ", "host"]) {
            encode(chunk({ content: word }));
            await Bun.sleep(TOKEN_DELAY_MS);
          }
          await gate;
          encode(
            `data: ${JSON.stringify({
              id: "1",
              object: "chat.completion.chunk",
              created: 0,
              model: "echo",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 11, completion_tokens: 7 },
            })}\n\n`
          );
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

beforeEach(async () => {
  requestSeen = new Promise((resolve) => {
    requested = resolve;
  });
  startModelServer();
  tmp = await mkdtemp(join(tmpdir(), "pim-session-host-test-"));
  agentDir = join(tmp, "agent");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await Bun.write(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        test: {
          baseUrl: `http://localhost:${server?.port}/v1`,
          api: "openai-completions",
          apiKey: "test-key",
          models: [{ id: "echo", maxTokens: 1024, contextWindow: 8192 }],
        },
      },
    })
  );
});

afterEach(async () => {
  gate = undefined;
  releaseGate?.();
  releaseGate = undefined;
  await Promise.all(hosts.map((host) => host.dispose()));
  hosts = [];
  await server?.stop(true);
  server = undefined;
  await rm(tmp, { recursive: true, force: true });
});

async function buildHost(
  overrides: Partial<SessionHostDeps> = {}
): Promise<SessionHost> {
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const host = new SessionHost({
    label: "test",
    settings: {},
    defaults: { cwd: tmp, model: MODEL_ID },
    agentDir,
    modelRuntime,
    modelRegistry: new ModelRegistry(modelRuntime),
    settingsManagerFor: (cwd) => SettingsManager.create(cwd, agentDir),
    persistSettings: async () => {},
    mainSessionPath: () => join(tmp, "sessions", "main.jsonl"),
    ...overrides,
  });
  hosts.push(host);
  return host;
}

test("resolves the configured model before an agent exists", async () => {
  const host = await buildHost();
  expect(host.currentModelId).toBe(MODEL_ID);
  expect(host.cwd).toBe(tmp);
  expect(host.status).toBe("idle");
  expect(host.sessionId).toBeUndefined();
});

test("prompts, streams, and lands the turn in the event log", async () => {
  const host = await buildHost();
  const seen: string[] = [];
  const statuses = new Set<string>();

  await host.run(async (agent) => {
    agent.subscribe((event) => {
      seen.push(event.type);
      statuses.add(host.status);
    });
    await agent.prompt("say hello");
  });

  expect(seen).toContain("agent_start");
  expect(seen).toContain("message_update");
  expect(seen).toContain("turn_end");
  expect(statuses).toContain("streaming");
  expect(host.status).toBe("idle");
  expect(host.tps).toBeGreaterThan(0);
  expect(host.sessionId).toBeString();

  const log = host.eventLog;
  expect(log).toBeDefined();
  const entries = await log!.read();
  const messages = entries.filter((e) => e.entry.type === "message");
  expect(messages.length).toBeGreaterThanOrEqual(2);
  expect(entries.map((e) => e.seq)).toEqual(entries.map((_, i) => i + 1));
});

test("aborts a running turn", async () => {
  const host = await buildHost();
  const release = holdTurn();
  const turn = host.run(async (agent) => {
    await agent.prompt("say hello");
  });

  await requestSeen;
  await until(() => host.isStreaming, "the turn to start streaming");
  expect(await host.cancel()).toEqual({ cancelled: true, restored: [] });
  release();
  await turn;

  expect(host.isStreaming).toBe(false);
  expect(host.status).toBe("idle");
  expect(await host.cancel()).toEqual({ cancelled: false, restored: [] });
});

test("rejects a cwd that is not a directory", async () => {
  const host = await buildHost();
  const missing = join(tmp, "nope");
  expect(await host.setCwd(missing)).toEqual({
    ok: false,
    error: `path does not exist: ${missing}`,
  });
});

test("retires the session file on clear", async () => {
  const retired: string[] = [];
  const host = await buildHost({
    settings: { sessionPath: join(tmp, "sessions", "main.jsonl") },
    onRetire: async (path) => {
      retired.push(path);
    },
  });

  await host.clear();
  expect(retired).toEqual([join(tmp, "sessions", "main.jsonl")]);
  expect(host.settings.sessionPath).toBeUndefined();
});

test("two hosts over one session file take their turns one at a time", async () => {
  const first = await buildHost({ lease: "daemon" });
  const second = await buildHost({ lease: "daemon" });
  const order: string[] = [];
  let leaseChanges = 0;
  second.onLeaseChange(() => {
    leaseChanges += 1;
  });
  const release = holdTurn();

  const one = first.run(async (agent) => {
    order.push("first:start");
    await agent.prompt("say hello");
    order.push("first:end");
  });
  await requestSeen;
  await until(() => first.isStreaming, "the first host to stream");

  const two = second.run(async (agent) => {
    order.push("second:start");
    await agent.prompt("say hello");
    order.push("second:end");
  });
  await until(() => !second.leaseState.writable, "the second host to block");

  expect(second.leaseState.heldBy).toEqual({
    frontend: "daemon",
    pid: process.pid,
  });
  expect(order).toEqual(["first:start"]);

  release();
  await Promise.all([one, two]);

  expect(order).toEqual([
    "first:start",
    "first:end",
    "second:start",
    "second:end",
  ]);
  expect(await roles()).toEqual(["user", "assistant", "user", "assistant"]);
  expect(second.leaseState).toEqual({ writable: true });
  expect(leaseChanges).toBe(2);
  expect(await leaseExists()).toBe(false);
});

test("a host whose file advanced rebuilds from it before its next turn", async () => {
  const first = await buildHost({ lease: "daemon" });
  const second = await buildHost({ lease: "daemon" });

  await first.run((agent) => agent.prompt("say hello"));
  const stale = first.agentSession;
  await second.run((agent) => agent.prompt("say hello"));

  let loaded = 0;
  await first.run(async (agent) => {
    loaded = agent.messages.length;
  });

  expect(stale).toBeDefined();
  expect(first.agentSession).not.toBe(stale);
  expect(loaded).toBe(4);

  // A turn that changed nothing on disk leaves the rebuilt agent alone.
  const rebuilt = first.agentSession;
  await first.run(async () => {});
  expect(first.agentSession).toBe(rebuilt);
});

test("clear and setModel hold the lease across their writes", async () => {
  const held: boolean[] = [];
  const host = await buildHost({
    lease: "daemon",
    settings: { sessionPath: mainPath() },
    persistSettings: async () => {
      held.push(await leaseExists());
    },
    onRetire: async () => {
      held.push(await leaseExists());
    },
  });

  expect(await host.setModel(MODEL_ID)).toEqual({ ok: true, id: MODEL_ID });
  await host.setThinkingLevel("high");
  await host.clear();

  expect(held).toEqual([true, true, true, true]);
  expect(await leaseExists()).toBe(false);
});

test("an isolated run takes no lease", async () => {
  const isolated = join(tmp, "sessions", "isolated.jsonl");
  const host = await buildHost({
    lease: "daemon",
    isolatedSessionPath: () => isolated,
  });
  let seen: readonly boolean[] = [];

  await host.run(
    async (agent) => {
      seen = [await leaseExists(), await leaseExists(isolated)];
      await agent.prompt("say hello");
    },
    { isolated: true }
  );

  expect(seen).toEqual([false, false]);
});

test("a turn that throws still gives the lease back", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const host = await buildHost({ lease: "daemon" });
  let heldDuringTurn = false;

  const turn = host.run(async () => {
    heldDuringTurn = await leaseExists();
    throw new Error("turn failed");
  });

  await expect(turn).rejects.toThrow("turn failed");
  expect(heldDuringTurn).toBe(true);
  expect(await leaseExists()).toBe(false);
  expect(host.leaseState).toEqual({ writable: true });
  expect(errors).toHaveBeenCalled();
  errors.mockRestore();
});

test("evicting a host from the registry leaves no lease behind", async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const registry = new SessionRegistry({
    defaults: { cwd: tmp, model: MODEL_ID },
    agentDir,
    capacity: 1,
  });
  try {
    await registry.init();
    const evicted = await registry.create({ cwd: tmp });
    await evicted.run((agent) => agent.prompt("say hello"));
    const sessionPath = evicted.settings.sessionPath;
    expect(sessionPath).toBeString();
    expect(await leaseExists(sessionPath!)).toBe(false);

    // `evictIfNeeded` disposes without awaiting, so nothing may outlive the turn.
    await registry.create({ cwd: tmp });

    expect(registry.peek(evicted.sessionId!)).toBeUndefined();
    expect(await leaseExists(sessionPath!)).toBe(false);
  } finally {
    await registry.disposeAll();
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
  }
});

/**
 * A `pi` that never took the lease appends while the daemon holds it. The turn
 * in flight is worth more than the inconsistency, so it finishes; the file is
 * what the next turn is rebuilt from.
 */
test("warns when another process writes the session mid-turn", async () => {
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  const host = await buildHost({ lease: "daemon" });
  let foreign = 0;
  host.onForeignWrite(() => {
    foreign += 1;
  });

  await host.run((agent) => agent.prompt("say hello"));
  const before = host.agentSession;

  const release = holdTurn();
  const turn = host.run((agent) => agent.prompt("say hello again"));
  await until(() => host.isStreaming, "the second turn to start streaming");
  await appendUnleased("written by a vanilla pi");
  release();
  await turn;

  expect(foreign).toBe(1);
  expect(warnings.mock.calls.flat().join(" ")).toContain(
    "written by another process"
  );
  expect(await roles()).toEqual([
    "user",
    "assistant",
    "user",
    "user",
    "assistant",
  ]);

  // The head was never marked as seen, so the next turn rebuilds from the file.
  let carried = false;
  await host.run(async (agent) => {
    carried = agent.sessionManager
      .getEntries()
      .some((entry) => entry.id === "unleased");
  });
  expect(host.agentSession).not.toBe(before);
  expect(carried).toBe(true);
  warnings.mockRestore();
});

/** Everything pi appends on this host's behalf moves both counts together. */
test("a host's own turns and out-of-turn writes are never foreign", async () => {
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const host = await buildHost({ lease: "daemon" });
  let foreign = 0;
  host.onForeignWrite(() => {
    foreign += 1;
  });

  await host.run((agent) => agent.prompt("say hello"));
  const built = host.agentSession;
  expect(await host.setModel(MODEL_ID)).toEqual({ ok: true, id: MODEL_ID });
  await host.setThinkingLevel("high");
  await host.run((agent) => agent.prompt("say hello again"));
  // pi refuses to compact a session this short, which still holds and gives back the lease.
  await expect(host.compact()).rejects.toThrow("Nothing to compact");

  expect(foreign).toBe(0);
  // Nothing looked stale either, so no turn ran against a rebuilt agent.
  expect(host.agentSession).toBe(built);
  errors.mockRestore();
  warnings.mockRestore();
});
