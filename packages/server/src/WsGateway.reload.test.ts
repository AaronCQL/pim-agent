import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { SessionRegistry } from "#core/session/SessionRegistry";
import type { UpdateOutcome } from "#core/shared/Updater";
import type { ServerEvent } from "#protocol/ServerEvent";
import { ProbeClient } from "./ProbeClient";
import { WsGateway } from "./WsGateway";

const STEP = "bun install";
const SKIPPED = [
  { label: "git pull", reason: "the working tree has uncommitted changes" },
] as const;
const UPDATED: UpdateOutcome = {
  ok: true,
  from: "1.4.0",
  to: "1.5.0",
  skipped: SKIPPED,
  error: undefined,
};

let tmp: string;
let agentDir: string;
let previousAgentDir: string | undefined;
let previousSupervised: string | undefined;
let modelServer: ReturnType<typeof Bun.serve> | undefined;
let registry: SessionRegistry;
let gateway: WsGateway;
let probes: ProbeClient[] = [];

/** Everything the injected seams were asked to do, and what they answer. */
let updates = 0;
let shutdowns = 0;
let outcome: UpdateOutcome;
/** Set by a test that needs the update still running while it asks again. */
let heldUpdate: Promise<void> | undefined;
/** Set by a test that needs a session mid-turn; the model waits on it. */
let heldTurn: Promise<void> | undefined;

function holdUpdate(): () => void {
  let release!: () => void;
  heldUpdate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => {
    heldUpdate = undefined;
    release();
  };
}

function holdTurn(): () => void {
  let release!: () => void;
  heldTurn = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => {
    heldTurn = undefined;
    release();
  };
}

function chunk(delta: Record<string, unknown>, finish?: string): string {
  return `data: ${JSON.stringify({
    id: "1",
    object: "chat.completion.chunk",
    created: 0,
    model: "echo",
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  })}\n\n`;
}

/** Streams one word and then waits, so a turn can be caught in flight. */
function startModelServer(): void {
  modelServer = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      const gate = heldTurn;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encode = (text: string) =>
            controller.enqueue(Buffer.from(text));
          encode(chunk({ role: "assistant", content: "" }));
          encode(chunk({ content: "working " }));
          await gate;
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

async function startGateway(): Promise<void> {
  registry = new SessionRegistry({
    defaults: { cwd: tmp, model: "test/echo" },
    agentDir,
  });
  await registry.init();
  gateway = new WsGateway({
    registry,
    port: 0,
    readCursorsPath: join(tmp, "read.json"),
    update: async (onStep) => {
      updates += 1;
      onStep(STEP);
      await heldUpdate;
      return outcome;
    },
    shutdown: async () => {
      shutdowns += 1;
    },
  });
  gateway.start();
}

async function connect(): Promise<ProbeClient> {
  const probe = new ProbeClient({ url: gateway.url, cwd: tmp });
  probes.push(probe);
  const attached = await probe.connect();
  expect(attached.success).toBe(true);
  return probe;
}

async function until(ready: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await Bun.sleep(1);
  }
}

function phaseOf(event: ServerEvent): string | undefined {
  return event.type === "update_state" ? event.phase : undefined;
}

function awaitPhase(probe: ProbeClient, phase: string): Promise<ServerEvent> {
  return probe.waitFor((event) => phaseOf(event) === phase, {
    timeoutMs: 10_000,
  });
}

beforeEach(async () => {
  updates = 0;
  shutdowns = 0;
  outcome = UPDATED;
  heldUpdate = undefined;
  heldTurn = undefined;
  startModelServer();
  tmp = await mkdtemp(join(tmpdir(), "pim-reload-test-"));
  agentDir = join(tmp, "agent");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // The restart path is the one under test, and only a supervised process has
  // one: unsupervised, an exit is the end rather than a replacement.
  previousSupervised = process.env.PIM_SUPERVISED;
  process.env.PIM_SUPERVISED = "1";
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
  await startGateway();
});

afterEach(async () => {
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
  if (previousSupervised === undefined) {
    delete process.env.PIM_SUPERVISED;
  } else {
    process.env.PIM_SUPERVISED = previousSupervised;
  }
  await rm(tmp, { recursive: true, force: true });
});

test("refuses to reload out from under a running turn, unless forced", async () => {
  const probe = await connect();
  const sessionId = probe.sessionId!;
  const release = holdTurn();
  const mark = probe.events.length;
  await probe.prompt("say hello");
  await probe.waitFor(
    (event) =>
      event.type === "session_activity" &&
      event.sessionId === sessionId &&
      event.status !== "idle",
    { from: mark }
  );

  const refused = await probe.send({ type: "reload" });
  expect(refused.success).toBe(false);
  // Named, because the operator is the only one who can decide whether that
  // particular turn is worth keeping.
  expect(refused.error).toContain(sessionId);
  expect(refused.error).toContain("mid-turn");
  expect(updates).toBe(0);

  const forced = await probe.send({ type: "reload", force: true });
  expect(forced.success).toBe(true);
  await until(
    () => shutdowns === 1,
    "the forced reload to take the server down"
  );
  release();
});

test("answers the client before it starts, and tells every one of them", async () => {
  const first = await connect();
  const second = await connect();

  const mark = first.events.length;
  const response = await first.send({ type: "reload" });
  expect(response.success).toBe(true);
  await awaitPhase(first, "step");
  // The ack cannot wait for the work: the work ends with this socket gone,
  // so an answer behind it is an answer nobody ever reads.
  const tail = first.events.slice(mark);
  expect(tail.findIndex((event) => event.type === "response")).toBeLessThan(
    tail.findIndex((event) => phaseOf(event) !== undefined)
  );

  for (const probe of [first, second]) {
    const step = await awaitPhase(probe, "step");
    expect(
      step.type === "update_state" && step.phase === "step" && step.label
    ).toBe(STEP);
    const restarting = await awaitPhase(probe, "restarting");
    expect(restarting).toEqual({
      type: "update_state",
      phase: "restarting",
      from: UPDATED.from,
      to: UPDATED.to,
      skipped: SKIPPED,
    });
  }
  await until(() => shutdowns === 1, "the server to be taken down");
  expect(updates).toBe(1);
});

test("a failed update is said to everyone, and this server keeps serving", async () => {
  outcome = {
    ok: false,
    from: "1.4.0",
    to: "1.4.0",
    skipped: [],
    error: "bun install: exit 1",
  };
  const first = await connect();
  const second = await connect();

  expect((await first.send({ type: "reload" })).success).toBe(true);
  for (const probe of [first, second]) {
    const failed = await awaitPhase(probe, "failed");
    expect(failed).toEqual({
      type: "update_state",
      phase: "failed",
      error: "bun install: exit 1",
    });
  }
  expect(shutdowns).toBe(0);
  // Still the server it was: a failed update leaves the working code running.
  expect(await first.listSessions()).toBeArray();
});

test("with nothing watching the process, it says so instead of exiting", async () => {
  delete process.env.PIM_SUPERVISED;
  const probe = await connect();

  expect((await probe.send({ type: "reload" })).success).toBe(true);
  const stranded = await awaitPhase(probe, "stranded");
  expect(stranded).toEqual({
    type: "update_state",
    phase: "stranded",
    from: UPDATED.from,
    to: UPDATED.to,
    skipped: SKIPPED,
  });
  expect(shutdowns).toBe(0);
});

test("two clients asking at once are one update", async () => {
  const first = await connect();
  const second = await connect();
  const release = holdUpdate();

  const answers = await Promise.all([
    first.send({ type: "reload" }),
    second.send({ type: "reload", force: true }),
  ]);
  expect(answers.map((answer) => answer.success)).toEqual([true, true]);
  await until(() => updates === 1, "the update to start");
  release();

  await until(() => shutdowns === 1, "the server to be taken down");
  // The second click joined the run in flight rather than racing it over the
  // same tree.
  expect(updates).toBe(1);
});
