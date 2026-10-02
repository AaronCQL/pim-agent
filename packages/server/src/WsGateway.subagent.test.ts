import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Type } from "typebox";

import { SessionRegistry } from "#core/session/SessionRegistry";
import { SubagentLogs } from "#core/shared/SubagentLogs";
import { Tools, type PimToolDefinition } from "#core/shared/Tools";
import { isDurableEvent, type ServerEvent } from "#protocol/ServerEvent";
import { ProbeClient } from "./ProbeClient";
import { WsGateway } from "./WsGateway";

const CALL_ID = "call_1|fc_1";
const TASK = "find every call site of parseConfig";
const CHILD_ANSWER = "three of the nine are in tests";
const REPLY = "the subagent has answered";

let tmp: string;
let agentDir: string;
let previousAgentDir: string | undefined;
let previousPimHome: string | undefined;
let modelServer: ReturnType<typeof Bun.serve> | undefined;
let registry: SessionRegistry;
let gateway: WsGateway;
let probes: ProbeClient[] = [];

/** Parent session the tool writes its child log under. */
let parentSessionId = "";
let parked: Parked | undefined;
/** Close it to hold the call open before the child log exists. */
let unwritten: Gate | undefined;

const spawnSchema = Type.Object({ task: Type.String() });

/** A fake subagent: writes a child log and sends a tool update per entry. */
function spawnTool(): PimToolDefinition<
  typeof spawnSchema,
  { entries: number }
> {
  return {
    name: "spawn",
    label: "spawn",
    description: "run a subagent",
    parameters: spawnSchema,
    effect: { kind: "readOnly" },
    execute: async (callId, params, _signal, onUpdate) => {
      await unwritten?.shut;
      await writeChild(callId, "user", params.task);
      onUpdate?.({
        content: [{ type: "text", text: "working" }],
        details: { entries: 1 },
      });
      await parked?.answering.shut;
      await writeChild(callId, "assistant", CHILD_ANSWER);
      const result = {
        content: [{ type: "text" as const, text: CHILD_ANSWER }],
        details: { entries: 2 },
      };
      // Report before parking, so the answer is sent while the call is open.
      onUpdate?.(result);
      await parked?.settling.shut;
      return result;
    },
  };
}

/** Appends to the child log at the server-derived path, header first. */
async function writeChild(
  callId: string,
  role: string,
  text: string
): Promise<void> {
  const path = SubagentLogs.pathFor(parentSessionId, callId);
  if (path === null) {
    throw new Error(`no child log path for ${parentSessionId}/${callId}`);
  }
  const at = "2026-09-07T10:00:00.000Z";
  const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;
  if (!(await Bun.file(path).exists())) {
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(
      path,
      line({
        type: "session",
        version: 3,
        id: `${parentSessionId}-${callId}`,
        timestamp: at,
        cwd: tmp,
      })
    );
  }
  await appendFile(
    path,
    line({
      type: "message",
      id: `${role}-${text.length}`,
      parentId: null,
      timestamp: at,
      message: { role, content: [{ type: "text", text }] },
    })
  );
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

/** Calls `spawn` on the first request, answers on the second. */
function startModelServer(): void {
  modelServer = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      const body = (await req.json()) as {
        readonly messages: readonly { readonly role: string }[];
      };
      const isToolTurn = body.messages.at(-1)?.role !== "tool";
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encode = (s: string) => controller.enqueue(Buffer.from(s));
          encode(chunk({ role: "assistant", content: "" }));
          if (isToolTurn) {
            encode(
              chunk({
                tool_calls: [
                  {
                    index: 0,
                    id: CALL_ID,
                    type: "function",
                    function: {
                      name: "spawn",
                      arguments: JSON.stringify({ task: TASK }),
                    },
                  },
                ],
              })
            );
            encode(chunk({}, "tool_calls"));
          } else {
            encode(chunk({ content: REPLY }));
            encode(chunk({}, "stop"));
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

async function connect(): Promise<ProbeClient> {
  const probe = new ProbeClient({ url: gateway.url, cwd: tmp });
  probes.push(probe);
  expect((await probe.connect()).success).toBe(true);
  parentSessionId = probe.sessionId ?? "";
  return probe;
}

/** `subagent_events` payloads, oldest first. */
function watched(probe: ProbeClient): ReadonlyArray<readonly ServerEvent[]> {
  return probe.events
    .filter((event) => event.type === "subagent_events")
    .map((event) => event.events);
}

function seqsOf(events: readonly ServerEvent[]): readonly number[] {
  return events.filter(isDurableEvent).map((event) => event.seq);
}

function textsOf(events: readonly ServerEvent[]): readonly string[] {
  return events.flatMap((event) =>
    event.type === "message" ? [event.text] : []
  );
}

function idle(probe: ProbeClient, from: number): Promise<ServerEvent> {
  return probe.waitFor(
    (event) => event.type === "session_state" && event.status === "idle",
    { from, timeoutMs: 20_000 }
  );
}

type Gate = { readonly shut: Promise<void>; readonly open: () => void };

type Parked = {
  /** Awaited before the child writes its answer. */
  readonly answering: Gate;
  /** Awaited after the parent reports the answer, before returning. */
  readonly settling: Gate;
};

type Held = {
  /** Lets the child answer; the call stays open. */
  readonly answer: () => void;
  /** Lets the call return. */
  readonly settle: () => void;
};

function gate(): Gate {
  let open!: () => void;
  const shut = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { shut, open };
}

/** Parks the tool before and after the child's answer, so a live drain is distinguishable from the settle drain. */
function holdChild(): Held {
  const held: Parked = { answering: gate(), settling: gate() };
  parked = held;
  return { answer: held.answering.open, settle: held.settling.open };
}

function holdFirstWrite(): () => void {
  const held = gate();
  unwritten = held;
  return () => {
    unwritten = undefined;
    held.open();
  };
}

beforeEach(async () => {
  startModelServer();
  tmp = await mkdtemp(join(tmpdir(), "pim-subagent-test-"));
  agentDir = join(tmp, "agent");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  previousPimHome = process.env.PIM_HOME_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // Never write into the developer's `~/.pim/subagents`.
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
  registry = new SessionRegistry({
    defaults: { cwd: tmp, model: "test/echo" },
    agentDir,
    customTools: () => [Tools.wrap(spawnTool()) as unknown as ToolDefinition],
  });
  await registry.init();
  gateway = new WsGateway({
    registry,
    port: 0,
    readCursorsPath: join(tmp, "read.json"),
    sessionMetaPath: join(tmp, "sessions.json"),
  });
  gateway.start();
});

afterEach(async () => {
  // Release parked tools so the session can be disposed.
  parked?.answering.open();
  parked?.settling.open();
  parked = undefined;
  unwritten?.open();
  unwritten = undefined;
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

test("watches a running child, and keeps it out of the parent transcript", async () => {
  const probe = await connect();
  const held = holdChild();
  const mark = probe.events.length;
  await probe.prompt("delegate this");
  await probe.waitFor((event) => event.type === "tool_update", { from: mark });

  expect((await probe.watchSubagent(CALL_ID)).success).toBe(true);
  // The header is line 1, so the first message is seq 2.
  expect(seqsOf(watched(probe)[0] ?? [])).toEqual([2]);
  expect(textsOf(watched(probe)[0] ?? [])).toEqual([TASK]);

  held.answer();
  await probe.waitFor(
    (event) =>
      event.type === "subagent_events" &&
      textsOf(event.events).includes(CHILD_ANSWER),
    { from: mark }
  );

  // Arrived while the call is still open, so it came from a live drain.
  expect(seqsOf(watched(probe)[1] ?? [])).toEqual([3]);
  expect(
    probe.events.some(
      (event) => event.type === "tool_result" && event.callId === CALL_ID
    )
  ).toBe(false);

  held.settle();
  await idle(probe, mark);

  // Settling adds nothing.
  expect(watched(probe)).toHaveLength(2);
  // The child's words never enter the parent transcript.
  expect(
    probe.events
      .filter(isDurableEvent)
      .flatMap((event) => (event.type === "message" ? [event.text] : []))
  ).not.toContain(TASK);
});

test("resumes a watch from `fromSeq` rather than replaying it", async () => {
  const probe = await connect();
  const mark = probe.events.length;
  await probe.prompt("delegate this");
  await idle(probe, mark);

  await probe.watchSubagent(CALL_ID, 2);

  expect(seqsOf(watched(probe)[0] ?? [])).toEqual([3]);
  expect(textsOf(watched(probe)[0] ?? [])).toEqual([CHILD_ANSWER]);
});

test("a watch opened before the child's first line still reads it", async () => {
  const probe = await connect();
  const held = holdChild();
  const release = holdFirstWrite();
  const mark = probe.events.length;
  await probe.prompt("delegate this");
  await probe.waitFor(
    (event) => event.type === "tool_call" && event.callId === CALL_ID,
    { from: mark }
  );
  expect(
    await Bun.file(SubagentLogs.pathFor(parentSessionId, CALL_ID)!).exists()
  ).toBe(false);

  expect((await probe.watchSubagent(CALL_ID)).success).toBe(true);
  expect(watched(probe)).toHaveLength(0);

  release();
  await probe.waitFor(
    (event) =>
      event.type === "subagent_events" && textsOf(event.events).includes(TASK),
    { from: mark }
  );

  held.answer();
  held.settle();
  await idle(probe, mark);
  expect(watched(probe).flatMap(textsOf)).toEqual([TASK, CHILD_ANSWER]);
});

test("stops sending a child's events once it is unwatched", async () => {
  const probe = await connect();
  const held = holdChild();
  const mark = probe.events.length;
  await probe.prompt("delegate this");
  await probe.waitFor((event) => event.type === "tool_update", { from: mark });
  await probe.watchSubagent(CALL_ID);

  expect((await probe.unwatchSubagent(CALL_ID)).success).toBe(true);
  held.answer();
  held.settle();
  // Once idle, everything has been sent.
  await idle(probe, mark);

  expect(watched(probe)).toHaveLength(1);
});

test.each([
  ["../../../etc/passwd", "no subagent log"],
  ["/etc/passwd", "no subagent log"],
  ["call_never_ran", "no subagent log"],
])("refuses the forged call id %p", async (callId, because) => {
  const probe = await connect();
  const mark = probe.events.length;
  await probe.prompt("delegate this");
  await idle(probe, mark);

  const response = await probe.watchSubagent(callId);

  expect(response.success).toBe(false);
  expect(response.error).toContain(because);
  expect(watched(probe)).toHaveLength(0);
});

test("refuses a watch on a session the client is not attached to", async () => {
  const watcher = await connect();
  const mark = watcher.events.length;
  await watcher.prompt("delegate this");
  await idle(watcher, mark);
  const owner = watcher.sessionId ?? "";

  const other = await connect();
  const response = await other.send({
    type: "watch_subagent",
    sessionId: owner,
    callId: CALL_ID,
    fromSeq: 0,
  });

  expect(response.success).toBe(false);
  expect(response.error).toContain("not attached to session");
  expect(watched(other)).toHaveLength(0);
});

test("keeps child logs out of the session catalogue", async () => {
  const probe = await connect();
  const mark = probe.events.length;
  await probe.prompt("delegate this");
  await idle(probe, mark);

  const sessions = await probe.listSessions();

  expect(sessions.map((session) => session.sessionId)).toEqual([
    probe.sessionId ?? "",
  ]);
});
