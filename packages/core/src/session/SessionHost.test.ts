import {
  ModelRegistry,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getSystemMessageText } from "@earendil-works/pi-ai";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { EventLog } from "./EventLog";
import { SessionHost, type SessionHostDeps } from "./SessionHost";
import { SessionLease } from "./SessionLease";
import { SessionRegistry } from "./SessionRegistry";
import { until } from "../shared/fixtures/wait";
import {
  FakeSession,
  HeldSession,
  parent,
} from "../extensions/subagent/fixtures/session";
import { startSubagent } from "../extensions/subagent/subagent";
import { SubagentJobs } from "../extensions/subagent/SubagentJobs";
import type { SubagentResultMessage } from "../extensions/subagent/SubagentResult";

const MODEL_ID = "test/echo";

let tmp: string;
let agentDir: string;
let server: ReturnType<typeof Bun.serve> | undefined;
let hosts: SessionHost[] = [];
type ChatRequest = {
  readonly messages: readonly {
    readonly role: string;
    readonly content: unknown;
  }[];
  readonly tools?: readonly {
    readonly function: { readonly name: string; readonly description: string };
  }[];
};
let requests: ChatRequest[] = [];

function wireRoles(request: ChatRequest | undefined): readonly string[] {
  return request?.messages.map((message) => message.role) ?? [];
}

function expectPrefix(earlier: ChatRequest, later: ChatRequest): void {
  expect(later.messages.slice(0, earlier.messages.length)).toEqual([
    ...earlier.messages,
  ]);
}

let requested: () => void;
let requestSeen: Promise<void>;

/** Only makes deltas arrive separately; use `holdTurn` to keep a turn open. */
const TOKEN_DELAY_MS = 1;

/** Stalls the reply before its final chunk. */
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

/** Appends a message as a pi that never took the lease would. */
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

/** OpenAI-compatible endpoint streaming a fixed reply; stalls on `gate`. */
function startModelServer(): void {
  server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      requests.push((await req.json()) as ChatRequest);
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
  requests = [];
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
          models: [
            {
              id: "echo",
              maxTokens: 1024,
              contextWindow: 8192,
              compat: { supportsMidConvoSystemMessages: true },
            },
          ],
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

/** The clock stays out of the system prompt so the cached prefix is stable. */
test("stamps the clock ahead of the user's message", async () => {
  const host = await buildHost();
  await host.run((agent) => agent.prompt("say hello"));

  let seen: readonly string[] = [];
  let stamp: unknown;
  await host.run(async (agent) => {
    seen = agent.messages.map((message) => message.role);
    stamp = agent.messages[0];
  });

  expect(seen).toEqual(["custom", "system", "user", "assistant"]);
  expect(stamp).toMatchObject({
    customType: "pim-datetime",
    display: false,
  });
  expect((stamp as { content: string }).content).toMatch(
    /^<datetime>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2} \(\w+\)<\/datetime>$/
  );
  expect(wireRoles(requests[0])).toEqual(["system", "user", "user"]);
  expect(JSON.stringify(requests[0]?.messages[1]?.content)).toContain(
    "<datetime>"
  );
});

test("lets pi record stable prompt sections and preserves project instructions", async () => {
  await Bun.write(join(tmp, "AGENTS.md"), "Follow the project rules.");
  const host = await buildHost({
    systemInstruction: async () => "Extra session instruction.",
  });
  await host.run((agent) => agent.prompt("say hello"));

  expect(wireRoles(requests[0])[0]).toBe("system");
  const providerPrompt = requests[0]?.messages[0]?.content as string;
  expect(providerPrompt).toContain("You are Pim (Pi IMproved)");
  expect(providerPrompt).not.toContain("Updated system prompt section");
  expect(providerPrompt).toContain("<environment>\n- os:");
  expect(providerPrompt).toContain("- model: echo via test");
  expect(providerPrompt).toContain("Follow the project rules.");
  expect(providerPrompt).toContain("Extra session instruction.");
  expect(providerPrompt).not.toContain("<datetime>");

  const entries = await new EventLog(mainPath()).read();
  const system = entries.flatMap((entry) =>
    entry.entry.type === "message" && entry.entry.message.role === "system"
      ? [entry.entry.message]
      : []
  );
  expect(system).toHaveLength(1);
  expect(system[0]?.sections?.preamble).toContain("You are Pim (Pi IMproved)");
  expect(system[0]?.sections?.environment).toContain("- model: echo via test");
  expect(system[0]?.sections?.cwd).toContain(tmp);
  expect(system[0]?.sections?.addendum).toContain("Extra session instruction.");
  expect(system[0]?.sections?.project_context).toContain(
    "Follow the project rules."
  );
  expect(system[0] && getSystemMessageText(system[0])).toBe(providerPrompt);

  await host.run((agent) => agent.prompt("say hello again"));
  expect((await roles()).filter((role) => role === "system")).toHaveLength(1);
  expect(wireRoles(requests[1]).filter((role) => role === "system")).toEqual([
    "system",
  ]);
  expectPrefix(requests[0]!, requests[1]!);

  await host.dispose();
  const resumed = await buildHost({
    systemInstruction: async () => "Extra session instruction.",
  });
  await resumed.run((agent) => agent.prompt("say hello after resume"));
  expectPrefix(requests[1]!, requests[2]!);
  expect((await roles()).filter((role) => role === "system")).toHaveLength(1);
});

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

test("binds pi's no-op UI until a sink is set", async () => {
  const silent = await buildHost();
  expect((await silent.ensureAgent()).extensionRunner.hasUI()).toBe(false);

  const heard = await buildHost({
    mainSessionPath: () => join(tmp, "sessions", "heard.jsonl"),
    ui: () => ({
      notify: () => {},
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
    }),
  });
  expect((await heard.ensureAgent()).extensionRunner.hasUI()).toBe(true);
});

test("aborts a running turn", async () => {
  const host = await buildHost();
  const release = holdTurn();
  const turn = host.run(async (agent) => {
    await agent.prompt("say hello");
  });

  await requestSeen;
  await until(() => host.isStreaming, "the turn to start streaming");
  expect(await host.cancel()).toEqual({
    cancelled: true,
    aborted: true,
    stopped: 0,
    restored: [],
  });
  release();
  await turn;

  expect(host.isStreaming).toBe(false);
  expect(host.status).toBe("idle");
  expect(await host.cancel()).toEqual({
    cancelled: false,
    aborted: false,
    stopped: 0,
    restored: [],
  });
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
  expect(await roles()).toEqual([
    "system",
    "user",
    "assistant",
    "user",
    "assistant",
  ]);
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

  let loaded: readonly string[] = [];
  await first.run(async (agent) => {
    loaded = agent.messages.map((message) => message.role);
  });

  expect(stale).toBeDefined();
  expect(first.agentSession).not.toBe(stale);
  expect(loaded).toEqual([
    "custom",
    "system",
    "user",
    "assistant",
    "custom",
    "user",
    "assistant",
  ]);

  // An unchanged file does not trigger another rebuild.
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

test("renames through pi, holding the lease over the one line it appends", async () => {
  const host = await buildHost({ lease: "daemon" });
  await host.run((agent) => agent.prompt("say hello"));
  const seen: string[] = [];
  host.subscribe((event) => {
    seen.push(event.type);
  });
  const before = await new EventLog(mainPath()).read();

  expect(await host.setName("  Sidebar  rename\n")).toBe("Sidebar rename");

  const after = await new EventLog(mainPath()).read();
  expect(after.length).toBe(before.length + 1);
  expect(after.at(-1)?.entry.type).toBe("session_info");
  expect(await new EventLog(mainPath()).name()).toBe("Sidebar rename");
  expect(host.agentSession?.sessionManager.getSessionName()).toBe(
    "Sidebar rename"
  );
  expect(seen).toContain("session_info_changed");
  expect(await leaseExists()).toBe(false);

  expect(await host.setName(null)).toBeUndefined();
  expect(await new EventLog(mainPath()).name()).toBeUndefined();
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

    // Eviction disposes without awaiting.
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
    "system",
    "user",
    "assistant",
    "user",
    "user",
    "assistant",
  ]);

  // The next turn rebuilds from the file.
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

test("takes up a name another process gave the session mid-turn, without warning", async () => {
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  const host = await buildHost({ lease: "daemon" });
  await host.setName("old name");
  await host.run((agent) => agent.prompt("say hello"));

  const release = holdTurn();
  const turn = host.run((agent) => agent.prompt("say hello again"));
  await until(() => host.isStreaming, "the second turn to start streaming");
  const entries = await new EventLog(mainPath()).read();
  await appendFile(
    mainPath(),
    `${JSON.stringify({
      type: "session_info",
      id: "renamed",
      parentId: entries.at(-1)?.entry.id ?? null,
      timestamp: new Date().toISOString(),
      name: "new name",
    })}\n`
  );
  release();
  await turn;

  expect(await new EventLog(mainPath()).name()).toBe("new name");
  expect((await host.ensureAgent()).sessionManager.getSessionName()).toBe(
    "new name"
  );
  expect(warnings).not.toHaveBeenCalled();
  warnings.mockRestore();
});

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
  // Too short to compact, but still takes and releases the lease.
  await expect(host.compact()).rejects.toThrow("Nothing to compact");

  expect(foreign).toBe(0);
  // And nothing triggered a rebuild.
  expect(host.agentSession).toBe(built);
  errors.mockRestore();
  warnings.mockRestore();
});

describe("background subagent jobs", () => {
  const jobsInUse: SubagentJobs[] = [];

  afterEach(async () => {
    await Promise.all(jobsInUse.map((jobs) => jobs.stopEverything()));
    jobsInUse.length = 0;
  });

  async function jobHost(
    overrides: Partial<SessionHostDeps> = {},
    jobs = new SubagentJobs()
  ) {
    jobsInUse.push(jobs);
    const host = await buildHost({ jobs, lease: "daemon", ...overrides });
    await host.run((agent) => agent.prompt("say hello"));
    const id = host.sessionId!;
    const spawn = async (
      callId: string,
      session: FakeSession = new HeldSession()
    ): Promise<FakeSession> => {
      jobs.spawn(id, {
        callId,
        prompt: `task ${callId}`,
        lastHandle: 0,
        start: (onChange) =>
          startSubagent(`task ${callId}`, parent, {
            createSession: async () => session,
            onChange,
          }),
      });
      await until(() => session.promptCalls === 1, "the child prompt");
      return session;
    };
    const held = async (callId: string): Promise<HeldSession> =>
      (await spawn(callId)) as HeldSession;
    return { host, jobs, id, spawn: held, spawnStubborn: spawn };
  }

  /** Streams a turn the model server holds open until the returned release. */
  async function heldTurn(host: SessionHost) {
    const release = holdTurn();
    const turn = host.run((agent) => agent.prompt("keep going"));
    await until(
      () => host.isStreaming && requests.length === 2,
      "the turn to stream"
    );
    return { release, turn };
  }

  async function results(): Promise<
    readonly SubagentResultMessage["details"][]
  > {
    const entries = await new EventLog(mainPath()).read();
    return entries.flatMap(({ entry }) =>
      entry.type === "custom_message" && entry.customType === "subagent_result"
        ? [entry.details as SubagentResultMessage["details"]]
        : []
    );
  }

  test("tells the model it can work in the background", async () => {
    await jobHost();

    const subagent = requests[0]?.tools?.find(
      (tool) => tool.function.name === "subagent"
    );
    expect(subagent?.function.description).toContain("wakes you");
  });

  test("a job finishing while idle wakes the agent through the turn queue", async () => {
    const { host, spawn } = await jobHost();
    const session = await spawn("call-1");

    session.finish("the answer");
    await until(() => requests.length === 2, "the wake-up request");
    await until(
      async () => (await roles()).filter((r) => r === "assistant").length === 2,
      "the wake-up turn"
    );

    expect(await results()).toMatchObject([{ jobId: "call-1", state: "done" }]);
    expect(JSON.stringify(requests[1]?.messages)).toContain(
      "[subagent job j1 done]\\nthe answer"
    );
    await until(async () => !(await leaseExists()), "the lease to free");
    expect(host.isStreaming).toBe(false);
  });

  test("a surface can own the turn a job wakes", async () => {
    const woken: string[] = [];
    let host: SessionHost | undefined;
    const built = await jobHost({
      runWake: async (work) => {
        woken.push("wake");
        await host!.run(work);
      },
    });
    host = built.host;
    const session = await built.spawn("call-1");

    session.finish("done");
    await until(() => requests.length === 2, "the wake-up request");

    expect(woken).toEqual(["wake"]);
  });

  test("a job finishing mid-turn lands at that turn's end and continues it", async () => {
    const { host, jobs, id, spawn } = await jobHost();
    const session = await spawn("call-1");
    const { release, turn } = await heldTurn(host);

    session.finish("mid-turn answer");
    await until(() => !jobs.hasRunning(id), "the job to finish");
    expect(jobs.has(id, "call-1")).toBe(true);
    release();
    await turn;

    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[2]?.messages)).toContain("mid-turn answer");
    expect(await results()).toMatchObject([{ jobId: "call-1", state: "done" }]);
  });

  test("cancel while idle stops the jobs and appends their results without a turn", async () => {
    const { host, jobs, spawn } = await jobHost();
    await spawn("call-1");

    expect(await host.cancel()).toEqual({
      cancelled: true,
      aborted: false,
      stopped: 1,
      restored: [],
    });
    await until(
      async () => (await results()).length === 1,
      "the stopped result"
    );

    expect(jobs.hasRunning(host.sessionId!)).toBe(false);
    expect(await results()).toMatchObject([
      { jobId: "call-1", state: "stopped", stoppedBy: "user" },
    ]);
    expect(requests).toHaveLength(1);
    expect(await host.cancel()).toEqual({
      cancelled: false,
      aborted: false,
      stopped: 0,
      restored: [],
    });
  });

  test("cancel mid-turn stops the turn and the jobs", async () => {
    const { host, jobs, spawn } = await jobHost();
    await spawn("call-1");
    const release = holdTurn();
    const turn = host.run((agent) => agent.prompt("keep going"));
    await until(
      () => host.isStreaming && requests.length === 2,
      "the turn to stream"
    );

    expect((await host.cancel()).cancelled).toBe(true);
    release();
    await turn;

    expect(jobs.hasRunning(host.sessionId!)).toBe(false);
    await until(
      async () => (await results()).length === 1,
      "the stopped result"
    );
    expect(requests).toHaveLength(2);
  });

  test("a turn aborted other than by cancel, as /resume and /new do, leaves the jobs running", async () => {
    const { host, jobs, spawn } = await jobHost();
    await spawn("call-1");
    const release = holdTurn();
    const turn = host.run((agent) => agent.prompt("keep going"));
    await until(
      () => host.isStreaming && requests.length === 2,
      "the turn to stream"
    );

    await host.agentSession!.abort();
    release();
    await turn;

    expect(jobs.hasRunning(host.sessionId!)).toBe(true);
    expect(await results()).toEqual([]);
  });

  test("rebuilding the agent keeps the jobs and their delivery", async () => {
    const { host, spawn } = await jobHost();
    const session = await spawn("call-1");

    await host.invalidate();
    expect(host.agentSession).toBeUndefined();
    expect(host.sessionId).toBeUndefined();
    expect(host.jobs.map((job) => job.id)).toEqual(["call-1"]);

    session.finish("after the rebuild");
    await until(() => requests.length === 2, "the wake-up request");
    await until(async () => (await results()).length === 1, "the result");
  });

  test("clearing the session stops its jobs and keeps their results for it", async () => {
    const { host, jobs, spawn } = await jobHost();
    await spawn("call-1");
    const left = host.sessionId!;

    await host.clear();

    expect(jobs.hasRunning(left)).toBe(false);
    expect(jobs.has(left, "call-1")).toBe(true);
    expect(host.jobs).toEqual([]);
  });

  test("stopping everything lands the stopped results before the host is disposed", async () => {
    const warnings = spyOn(console, "warn");
    const { host, jobs, spawn } = await jobHost();
    await spawn("call-1");

    await jobs.stopEverything();
    await host.dispose();

    expect(await results()).toMatchObject([
      { jobId: "call-1", state: "stopped", stoppedBy: "user" },
    ]);
    expect(warnings).not.toHaveBeenCalled();
    warnings.mockRestore();
  });

  test("a delivery still queued when the host is disposed gives up without rebuilding the agent, and keeps the result", async () => {
    const warnings = spyOn(console, "warn").mockImplementation(() => {});
    const { host, jobs, spawn } = await jobHost();
    const session = await spawn("call-1");
    const id = host.sessionId!;
    const busy = Promise.withResolvers<void>();
    const blocker = host.serialize(() => busy.promise);

    session.finish("too late");
    await until(() => !jobs.hasRunning(id), "the job to finish");
    await host.dispose();
    busy.resolve();
    await blocker;
    await until(
      () => warnings.mock.calls.length > 0,
      "the delivery to give up"
    );

    expect(host.agentSession).toBeUndefined();
    expect(jobs.has(id, "call-1")).toBe(true);
    expect(await results()).toEqual([]);
    expect(String(warnings.mock.calls[0]?.[1])).toContain(
      "disposed before queued work ran"
    );
    warnings.mockRestore();
  });

  test("exposes the running jobs, pinned while any runs", async () => {
    const { host, spawn } = await jobHost();
    let changes = 0;
    host.onJobsChange(() => {
      changes += 1;
    });
    expect(host.pinned).toBe(false);

    const session = await spawn("call-1");
    expect(host.jobs.map((job) => job.title)).toEqual(["task call-1"]);
    expect(host.pinned).toBe(true);
    expect(changes).toBeGreaterThan(0);

    session.finish("done");
    await until(() => !host.pinned, "the job to finish");
    expect(host.jobs).toEqual([]);
  });

  test("a result that lands mid-turn survives the queue being taken back, and wakes the agent", async () => {
    const { host, jobs, id, spawn } = await jobHost();
    const session = await spawn("call-1");
    const { release, turn } = await heldTurn(host);

    session.finish("mid-turn answer");
    await until(() => !jobs.hasRunning(id), "the job to finish");
    host.takeBack();
    release();
    await turn;

    expect(await results()).toMatchObject([{ jobId: "call-1", state: "done" }]);
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[2]?.messages)).toContain("mid-turn answer");
  });

  test("a result that lands in a turn ended by some other abort is appended after it, and wakes the agent", async () => {
    const { host, jobs, id, spawn } = await jobHost();
    const session = await spawn("call-1");
    const { release, turn } = await heldTurn(host);

    session.finish("the answer");
    await until(() => !jobs.hasRunning(id), "the job to finish");
    await host.agentSession!.abort();
    release();
    await turn;
    await until(() => requests.length === 3, "the wake-up request");
    await host.serialize(async () => {});

    expect(await results()).toMatchObject([{ jobId: "call-1", state: "done" }]);
    expect(JSON.stringify(requests[2]?.messages)).toContain("the answer");
  });

  test("cancel keeps a result whose delivery is already queued from waking the agent", async () => {
    const { host, jobs, id, spawn } = await jobHost();
    const session = await spawn("call-1");
    const busy = Promise.withResolvers<void>();
    const blocker = host.serialize(() => busy.promise);

    session.finish("the answer");
    await until(() => !jobs.hasRunning(id), "the job to finish");
    await host.cancel();
    busy.resolve();
    await blocker;
    await host.serialize(async () => {});

    expect(await results()).toMatchObject([{ jobId: "call-1", state: "done" }]);
    expect(requests).toHaveLength(1);
  });

  test("stays pinned until a finished job's result is in the session", async () => {
    const { host, jobs, id, spawn } = await jobHost();
    const session = await spawn("call-1");
    const busy = Promise.withResolvers<void>();
    const blocker = host.serialize(() => busy.promise);

    session.finish("the answer");
    await until(() => !jobs.hasRunning(id), "the job to finish");
    expect(host.pinned).toBe(true);

    busy.resolve();
    await blocker;
    await until(() => !host.pinned, "the result to land");
    expect(await results()).toHaveLength(1);
  });

  test("a disposed host never takes delivery back from the live one", async () => {
    const { host: zombie, jobs, id, spawn } = await jobHost();
    await zombie.dispose();
    const live = await buildHost({ jobs, lease: "daemon" });
    await live.ensureAgent();
    await zombie.run(async () => {});

    const session = await spawn("call-1");
    session.finish("the answer");

    await until(
      () =>
        live.agentSession?.sessionManager
          .getBranch()
          .some(
            (entry) =>
              entry.type === "custom_message" &&
              entry.customType === "subagent_result"
          ) === true,
      "the live host to deliver"
    );
    expect(live.sessionId).toBe(id);
  });

  test("cancel gives up on a child that ignores the stop once the grace runs out", async () => {
    const grace = Promise.withResolvers<void>();
    const { host, jobs, id, spawnStubborn } = await jobHost(
      {},
      new SubagentJobs({ grace: () => grace.promise })
    );
    const stubborn = new FakeSession(() => new Promise(() => {}));
    await spawnStubborn("call-1", stubborn);

    const cancelling = host.cancel();
    await until(() => stubborn.abortCalls === 1, "the stop");
    grace.resolve();

    expect(await cancelling).toEqual({
      cancelled: true,
      aborted: false,
      stopped: 1,
      restored: [],
    });
    expect(jobs.hasRunning(id)).toBe(false);
    await until(async () => (await results()).length === 1, "the result");
    expect(await results()).toMatchObject([
      { jobId: "call-1", state: "stopped", stoppedBy: "user" },
    ]);
  });
});

test("a registry hands its jobs to its hosts and keeps their sessions cached", async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const jobs = new SubagentJobs();
  const registry = new SessionRegistry({
    defaults: { cwd: tmp, model: MODEL_ID },
    agentDir,
    capacity: 1,
    jobs,
  });
  try {
    await registry.init();
    const busy = await registry.create({ cwd: tmp });
    const session = new HeldSession();
    jobs.spawn(busy.sessionId!, {
      callId: "call-1",
      prompt: "task",
      lastHandle: 0,
      start: () =>
        startSubagent("task", parent, { createSession: async () => session }),
    });

    await registry.create({ cwd: tmp });

    expect(busy.pinned).toBe(true);
    expect(registry.peek(busy.sessionId!)).toBe(busy);
  } finally {
    await jobs.stopEverything();
    await registry.disposeAll();
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
  }
});
