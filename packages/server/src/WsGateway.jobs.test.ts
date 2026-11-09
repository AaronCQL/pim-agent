import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import {
  HeldSession,
  parent,
} from "#core/extensions/subagent/fixtures/session";
import { startSubagent } from "#core/extensions/subagent/subagent";
import {
  SubagentJobs,
  type JobView,
} from "#core/extensions/subagent/SubagentJobs";
import type { SessionHost } from "#core/session/SessionHost";
import { SessionRegistry } from "#core/session/SessionRegistry";
import { until } from "#core/shared/fixtures/wait";
import type { ServerEvent } from "#protocol/ServerEvent";
import { ProbeClient } from "./ProbeClient";
import { SessionStream } from "./SessionStream";
import { WsGateway } from "./WsGateway";

const CALL_ID = "call_spawn";
const TASK = "audit every caller of parseConfig";
const NOTES = "notes.txt";
const CHILD_ANSWER = "three of the nine callers are in tests";
const SPAWNED = "it is running; I will wait";
const REPLY = "the audit is back";
const RESULT_HEADLINE = "[subagent job";
const HOLD = "keep at it";
const HELD = "still at it";
const CHAT = "just say hi";
const HI = "hi";

type Gate = { readonly shut: Promise<void>; readonly open: () => void };

type ChatMessage = {
  readonly role: string;
  readonly content?: unknown;
};

let tmp: string;
let agentDir: string;
let previousAgentDir: string | undefined;
let previousPimHome: string | undefined;
let modelServer: ReturnType<typeof Bun.serve> | undefined;
let jobs: SubagentJobs;
let registry: SessionRegistry;
let gateway: WsGateway;
let probes: ProbeClient[] = [];
let updates = 0;
/** Holds the child's first model call, before its log has a line. */
let childStart: Gate;
/** Holds the child's answer, after it has read `NOTES`. */
let childAnswer: Gate;
/** Holds the parent's answer to `HOLD`. */
let parentHold: Gate;
/** What the parent's model saw, request by request. */
let parentRequests: string[] = [];

function gate(): Gate {
  let open!: () => void;
  const shut = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { shut, open };
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

function toolCall(id: string, name: string, args: unknown): string {
  return chunk({
    tool_calls: [
      {
        index: 0,
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });
}

/** The parent spawns, then waits; the child reads `NOTES`, then answers. */
async function reply(
  messages: readonly ChatMessage[]
): Promise<readonly string[]> {
  const last = messages.at(-1);
  const isChild = messages.some(
    (message) =>
      message.role === "user" && JSON.stringify(message).includes(TASK)
  );
  if (isChild) {
    if (last?.role !== "tool") {
      await childStart.shut;
      return [
        toolCall("call_read", "read", { path: join(tmp, NOTES) }),
        chunk({}, "tool_calls"),
      ];
    }
    await childAnswer.shut;
    return [chunk({ content: CHILD_ANSWER }), chunk({}, "stop")];
  }
  parentRequests.push(JSON.stringify(messages));
  if (last?.role === "tool") {
    return [chunk({ content: SPAWNED }), chunk({}, "stop")];
  }
  if (JSON.stringify(last).includes(CHAT)) {
    return [chunk({ content: HI }), chunk({}, "stop")];
  }
  if (JSON.stringify(last).includes(HOLD)) {
    await parentHold.shut;
    return [chunk({ content: HELD }), chunk({}, "stop")];
  }
  if (JSON.stringify(messages).includes(RESULT_HEADLINE)) {
    return [chunk({ content: REPLY }), chunk({}, "stop")];
  }
  return [
    toolCall(CALL_ID, "subagent", {
      action: "spawn",
      prompt: TASK,
    }),
    chunk({}, "tool_calls"),
  ];
}

function startModelServer(): void {
  modelServer = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      const body = (await req.json()) as {
        readonly messages: readonly ChatMessage[];
      };
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encode = (s: string) => controller.enqueue(Buffer.from(s));
          encode(chunk({ role: "assistant", content: "" }));
          for (const part of await reply(body.messages)) {
            encode(part);
          }
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

async function connect(sessionId?: string): Promise<ProbeClient> {
  const probe = new ProbeClient({
    url: gateway.url,
    cwd: tmp,
    ...(sessionId === undefined ? {} : { sessionId }),
  });
  probes.push(probe);
  expect((await probe.connect()).success).toBe(true);
  return probe;
}

function jobsIn(event: ServerEvent): readonly JobView[] | undefined {
  return event.type === "jobs" ? event.jobs : undefined;
}

function running(probe: ProbeClient, from: number): Promise<ServerEvent> {
  return probe.waitFor(
    (event) => jobsIn(event)?.some((job) => job.id === CALL_ID) === true,
    { from }
  );
}

function reading(probe: ProbeClient, from: number): Promise<ServerEvent> {
  return probe.waitFor(
    (event) =>
      jobsIn(event)?.some((job) => job.id === CALL_ID && job.turns > 0) ===
      true,
    { from }
  );
}

function idle(probe: ProbeClient, from: number): Promise<ServerEvent> {
  return probe.waitFor(
    (event) => event.type === "session_state" && event.status === "idle",
    { from }
  );
}

function result(
  probe: ProbeClient,
  from = 0
): Promise<Extract<ServerEvent, { readonly type: "subagent_result" }>> {
  return probe.waitFor(
    (event) => event.type === "subagent_result" && event.jobId === CALL_ID,
    { from }
  ) as Promise<Extract<ServerEvent, { readonly type: "subagent_result" }>>;
}

function spawnRow(
  probe: ProbeClient
): Extract<ServerEvent, { readonly type: "tool_result" }> | undefined {
  return probe.events.findLast(
    (event) => event.type === "tool_result" && event.callId === CALL_ID
  ) as Extract<ServerEvent, { readonly type: "tool_result" }> | undefined;
}

function activity(
  probe: ProbeClient
): Extract<ServerEvent, { readonly type: "session_activity" }> | undefined {
  return probe.events.findLast(
    (event) =>
      event.type === "session_activity" && event.sessionId === probe.sessionId
  ) as Extract<ServerEvent, { readonly type: "session_activity" }> | undefined;
}

function lastState(
  probe: ProbeClient
): Extract<ServerEvent, { readonly type: "session_state" }> | undefined {
  return probe.events.findLast((event) => event.type === "session_state");
}

function watchedTexts(probe: ProbeClient): readonly string[] {
  return probe.events.flatMap((event) =>
    event.type === "subagent_events"
      ? event.events.flatMap((inner) =>
          inner.type === "message" ? [inner.text] : []
        )
      : []
  );
}

/** Prompts, then waits until the parent's turn is over and the child is reading. */
async function spawnAndSettle(
  probe: ProbeClient,
  ask = "delegate the audit"
): Promise<number> {
  const mark = probe.events.length;
  await probe.prompt(ask);
  await running(probe, mark);
  await probe.waitFor(
    (event) => event.type === "message" && event.text === SPAWNED,
    { from: mark }
  );
  await idle(probe, mark);
  await reading(probe, mark);
  return mark;
}

beforeEach(async () => {
  updates = 0;
  childStart = gate();
  childStart.open();
  childAnswer = gate();
  parentHold = gate();
  parentRequests = [];
  startModelServer();
  tmp = await mkdtemp(join(tmpdir(), "pim-jobs-test-"));
  agentDir = join(tmp, "agent");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await Bun.write(join(tmp, NOTES), "parseConfig is called nine times\n");
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  previousPimHome = process.env.PIM_HOME_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // Child logs and settings stay out of the developer's `~/.pim`.
  process.env.PIM_HOME_DIR = join(tmp, "pim");
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
  jobs = new SubagentJobs();
  await serve();
});

async function serve(capacity?: number): Promise<void> {
  registry = new SessionRegistry({
    defaults: { cwd: tmp, model: "test/echo" },
    agentDir,
    jobs,
    ...(capacity === undefined ? {} : { capacity }),
  });
  await registry.init();
  gateway = new WsGateway({
    registry,
    port: 0,
    readCursorsPath: join(tmp, "read.json"),
    sessionMetaPath: join(tmp, "sessions.json"),
    update: async () => {
      updates += 1;
      return { ok: false, from: "", to: "", skipped: [], error: "refused" };
    },
    shutdown: async () => {},
  });
  gateway.start();
}

afterEach(async () => {
  // Before the gates open, or a held child would finish and wake its parent.
  await jobs.stopEverything();
  // Disposing a session under a delivery would rebuild its agent.
  await until(
    () =>
      probes.every(
        (probe) =>
          probe.sessionId === undefined || !jobs.has(probe.sessionId, CALL_ID)
      ),
    "every job's result to land"
  );
  childStart.open();
  childAnswer.open();
  parentHold.open();
  for (const probe of probes) {
    probe.close();
  }
  probes = [];
  await gateway.stop();
  await registry.disposeAll();
  await modelServer?.stop(true);
  modelServer = undefined;
  for (const [name, previous] of [
    ["PI_CODING_AGENT_DIR", previousAgentDir],
    ["PIM_HOME_DIR", previousPimHome],
  ] as const) {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
  await rm(tmp, { recursive: true, force: true });
});

test("a running job reaches every client, and its result lands as its own row and wakes the agent", async () => {
  const probe = await connect();
  const mark = await spawnAndSettle(probe);

  expect(lastState(probe)).toMatchObject({ status: "idle", repoBusy: true });
  expect(spawnRow(probe)?.child).toEqual({ jobId: CALL_ID, handle: "j1" });
  expect(activity(probe)).toMatchObject({ status: "idle", jobs: 1 });
  expect(await probe.listSessions()).toEqual([
    expect.objectContaining({ sessionId: probe.sessionId, jobs: 1 }),
  ]);
  const late = await connect(probe.sessionId);
  const handed = late.events.findLast((event) => event.type === "jobs");
  expect(jobsIn(handed!)).toEqual([
    expect.objectContaining({
      id: CALL_ID,
      handle: "j1",
      title: TASK,
    }),
  ]);
  expect(spawnRow(late)?.child).toEqual({ jobId: CALL_ID, handle: "j1" });

  childAnswer.open();
  const landed = await result(probe, mark);
  await probe.waitFor(
    (event) => event.type === "message" && event.text === REPLY,
    { from: mark }
  );
  await idle(probe, probe.events.indexOf(landed));

  expect(landed).toMatchObject({ state: "done", handle: "j1" });
  expect(JSON.stringify(landed.view)).toContain(CHILD_ANSWER);
  expect(
    jobsIn(probe.events.findLast((event) => event.type === "jobs")!)
  ).toEqual([]);
  expect(lastState(probe)?.repoBusy).toBeUndefined();
  expect(activity(probe)?.jobs).toBeUndefined();
  expect((await result(late)).messageId).toBe(landed.messageId);
});

test("cancel stops the jobs of an idle session, and their result says the user stopped them", async () => {
  const probe = await connect();
  const mark = await spawnAndSettle(probe);

  const cancelled = await probe.send({
    type: "cancel",
    sessionId: probe.sessionId!,
  });
  const landed = await result(probe, mark);

  await quiet(registry.peek(probe.sessionId!)!);

  expect(cancelled).toMatchObject({ success: true, restored: [] });
  expect(landed.state).toBe("stopped");
  expect(
    parentRequests.some((request) => request.includes(RESULT_HEADLINE))
  ).toBe(false);
  const cleared = probe.events.findLastIndex(
    (event) => jobsIn(event)?.length === 0
  );
  expect(cleared).toBeGreaterThan(mark);
  expect(cleared).toBeLessThan(probe.events.indexOf(cancelled));
  const again = await probe.send({
    type: "cancel",
    sessionId: probe.sessionId!,
  });
  expect(again).toMatchObject({ success: false, error: "nothing to cancel" });
});

test("watches a running job's child log as it grows", async () => {
  childStart = gate();
  const probe = await connect();
  const mark = probe.events.length;
  await probe.prompt("delegate the audit");
  await running(probe, mark);

  expect((await probe.watchSubagent(CALL_ID)).success).toBe(true);
  childStart.open();
  await probe.waitFor(
    (event) =>
      event.type === "subagent_events" &&
      event.events.some(
        (inner) => inner.type === "message" && inner.text.includes(TASK)
      ),
    { from: mark }
  );
  expect(probe.events.some((event) => event.type === "subagent_result")).toBe(
    false
  );

  childAnswer.open();
  const landed = await result(probe, mark);
  await until(
    () => watchedTexts(probe).includes(CHILD_ANSWER),
    "the child's answer to be watched"
  );
  await probe.waitFor(
    (event) => event.type === "message" && event.text === REPLY,
    { from: mark }
  );
  await idle(probe, probe.events.indexOf(landed));
});

test("refuses to reload or move the tree out from under a running job, naming its session", async () => {
  const probe = await connect();
  await spawnAndSettle(probe);

  const refused = await probe.send({ type: "reload" });
  const checkout = await probe.send({
    type: "checkout",
    sessionId: probe.sessionId!,
    branch: "main",
  });

  expect(refused.success).toBe(false);
  expect(refused.error).toContain(
    '"delegate the audit" (1 subagent) is working'
  );
  expect(updates).toBe(0);
  expect(checkout.error).toBe(
    `"delegate the audit" (1 subagent) is working in ${tmp}; wait for it to finish`
  );
});

test("names a working session by its sidebar title, cut between characters", async () => {
  const ask = `${"a".repeat(39)}😀 delegate the audit`;
  const probe = await connect();
  await spawnAndSettle(probe, ask);

  const refused = await probe.send({ type: "reload" });

  expect(refused.error).toStartWith(`"${ask}" (1 subagent) is working`);
});

test("refuses to reload while a session served elsewhere in the process runs a job", async () => {
  const probe = await connect();
  const elsewhere = "telegram-chat-session";
  jobs.spawn(elsewhere, {
    callId: "call_elsewhere",
    prompt: TASK,
    lastHandle: 0,
    start: (onChange) =>
      startSubagent("call_elsewhere", parent, {
        createSession: async () => new HeldSession(),
        onChange,
      }),
  });

  const refused = await probe.send({ type: "reload" });

  expect(refused.error).toStartWith(`${elsewhere} (1 subagent) is working`);
  expect(updates).toBe(0);
});

/** Prompts `HOLD`, then lets the job finish while the parent's turn streams with its reply held. */
async function holdParent(probe: ProbeClient): Promise<SessionHost> {
  const host = registry.peek(probe.sessionId!)!;
  await probe.prompt(HOLD);
  await until(() => host.isStreaming, "the parent's turn to stream");
  childAnswer.open();
  await until(
    () => !jobs.hasRunning(probe.sessionId!),
    "the job to finish mid-turn"
  );
  return host;
}

/** Waits out every turn the host has started or queued. */
async function quiet(host: SessionHost): Promise<void> {
  await until(() => !host.isStreaming, "the turn to end");
  await host.serialize(async () => {});
}

function resultIds(probe: ProbeClient): ReadonlySet<string> {
  return new Set(
    probe.events.flatMap((event) =>
      event.type === "subagent_result" && event.jobId === CALL_ID
        ? [event.messageId]
        : []
    )
  );
}

test("a result that lands while the user types into the running turn is kept, and wakes the agent", async () => {
  const probe = await connect();
  const mark = await spawnAndSettle(probe);
  const host = await holdParent(probe);

  await probe.prompt("and one more thing");
  parentHold.open();
  const landed = await result(probe, mark);
  await quiet(host);

  expect(landed.state).toBe("done");
  expect(resultIds(probe).size).toBe(1);
  const held = probe.events.findIndex(
    (event) => event.type === "message" && event.text === HELD
  );
  expect(held).toBeGreaterThan(mark);
  expect(probe.events.indexOf(landed)).toBeGreaterThan(held);
  expect(
    parentRequests.find((request) => request.includes("one more thing"))
  ).toContain(CHILD_ANSWER);
});

test("a result that lands in a turn some other abort ends is recorded once", async () => {
  const probe = await connect();
  const mark = await spawnAndSettle(probe);
  const host = await holdParent(probe);

  await host.agentSession!.abort();
  parentHold.open();
  await result(probe, mark);
  await quiet(host);
  const asked = parentRequests.length;
  await probe.prompt("what came back?");
  await until(() => parentRequests.length > asked, "the next request");
  await quiet(host);

  expect(resultIds(probe).size).toBe(1);
});

describe("with room for one live session", () => {
  beforeEach(async () => {
    await gateway.stop();
    await registry.disposeAll();
    await serve(1);
  });

  async function chat(probe: ProbeClient): Promise<void> {
    const mark = probe.events.length;
    await probe.prompt(CHAT);
    await probe.waitFor(
      (event) => event.type === "message" && event.text === HI,
      {
        from: mark,
      }
    );
    await idle(probe, mark);
  }

  /** Moves `probe` to a new session, leaving its old one unattached. */
  async function leave(probe: ProbeClient): Promise<string> {
    const left = probe.sessionId!;
    expect(
      (await probe.send({ type: "attach", cwd: tmp, fromSeq: 0 })).success
    ).toBe(true);
    return left;
  }

  async function spawnAndLand(probe: ProbeClient): Promise<void> {
    const mark = await spawnAndSettle(probe);
    childAnswer.open();
    const landed = await result(probe, mark);
    await probe.waitFor(
      (event) => event.type === "message" && event.text === REPLY,
      { from: mark }
    );
    expect(landed.state).toBe("done");
  }

  test("a session another one crowds out keeps its jobs while a client reads it", async () => {
    const first = await connect();
    await chat(first);
    await chat(await connect());

    await spawnAndLand(first);
  });

  test("an unattached session crowded out of the cache is rebuilt when a client returns", async () => {
    const first = await connect();
    await chat(first);
    const left = await leave(first);
    await connect();
    expect(registry.peek(left)).toBeUndefined();

    await spawnAndLand(await connect(left));
  });

  test("a session another tab crowds out while a client attaches to it stays live for that client", async () => {
    const first = await connect();
    await chat(first);
    const left = await leave(first);
    await connect();
    expect(registry.peek(left)).toBeUndefined();
    const refreshing = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const refresh = SessionStream.prototype.refresh;
    const held = spyOn(SessionStream.prototype, "refresh").mockImplementation(
      async function (this: SessionStream) {
        if (this.sessionId === left) {
          refreshing.resolve();
          await proceed.promise;
        }
        return await refresh.call(this);
      }
    );

    try {
      const again = new ProbeClient({ url: gateway.url, sessionId: left });
      probes.push(again);
      const attaching = again.connect();
      await refreshing.promise;
      await connect();
      proceed.resolve();
      expect((await attaching).success).toBe(true);
      held.mockRestore();

      const mark = again.events.length;
      expect(await again.prompt(CHAT)).toMatchObject({ success: true });
      await again.waitFor(
        (event) => event.type === "message" && event.text === HI,
        { from: mark }
      );
    } finally {
      held.mockRestore();
    }
  });

  test("a session crowded out before it wrote its file is gone, not reborn under another id", async () => {
    const first = await connect();
    const left = await leave(first);
    await connect();

    const again = new ProbeClient({ url: gateway.url, sessionId: left });
    probes.push(again);
    const attached = await again.connect();

    expect(attached.success).toBe(false);
    expect(attached.error).toContain(`unknown session: ${left}`);
  });
});
