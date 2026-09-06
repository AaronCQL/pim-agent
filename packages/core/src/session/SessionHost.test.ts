import {
  ModelRegistry,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { SessionHost, type SessionHostDeps } from "./SessionHost";

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
  expect(log!.inFlight).toBeUndefined();
});

test("buffers the in-flight turn while it streams, then clears it", async () => {
  const host = await buildHost();
  const release = holdTurn();
  const turn = host.run(async (agent) => {
    await agent.prompt("say hello");
  });
  await requestSeen;
  await until(
    () => (host.eventLog?.inFlight?.text.length ?? 0) > 0,
    "the in-flight buffer to take a delta"
  );
  const midFlight = host.eventLog?.inFlight?.text;
  const busyStatus = host.status;
  release();
  await turn;

  expect(midFlight).toBeString();
  expect("hello from the host").toStartWith(midFlight!);
  expect(["thinking", "streaming"]).toContain(busyStatus);
  expect(host.eventLog?.inFlight).toBeUndefined();
});

test("aborts a running turn", async () => {
  const host = await buildHost();
  const release = holdTurn();
  const turn = host.run(async (agent) => {
    await agent.prompt("say hello");
  });

  await requestSeen;
  await until(() => host.isStreaming, "the turn to start streaming");
  expect(await host.cancel()).toBe(true);
  release();
  await turn;

  expect(host.isStreaming).toBe(false);
  expect(host.status).toBe("idle");
  expect(await host.cancel()).toBe(false);
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
