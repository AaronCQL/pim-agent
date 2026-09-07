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

const CALL_ID = "call_1";
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

/** Which session the tool writes its child log under; set once a probe has one. */
let parentSessionId = "";
/** Held by a test that wants to watch the child while it is still running. */
let release: (() => void) | undefined;
let held: Promise<void> | undefined;

const spawnSchema = Type.Object({ task: Type.String() });

/**
 * A subagent, reduced to what a watch can see of one: a child log written
 * under the parent's session and call id, and an update per entry — which is
 * the only signal the server gets that the child has written anything.
 */
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
      await writeChild(callId, "user", params.task);
      onUpdate?.({
        content: [{ type: "text", text: "working" }],
        details: { entries: 1 },
      });
      await held;
      await writeChild(callId, "assistant", CHILD_ANSWER);
      const result = {
        content: [{ type: "text" as const, text: CHILD_ANSWER }],
        details: { entries: 2 },
      };
      onUpdate?.(result);
      return result;
    },
  };
}

/**
 * Appends to the child's log at the path the server derives, with pi's header
 * as its first line — so its entries carry the ordinals a real child's would.
 */
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

/** Calls `spawn` on the first request of a turn, answers on the second. */
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

/** The child transcripts this probe was handed, oldest envelope first. */
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

/** Holds the tool open so a test can watch a child that is still running. */
function holdChild(): () => void {
  held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => {
    held = undefined;
    release?.();
    release = undefined;
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
  // Child logs are derived under this root, so a test run must never write
  // into the developer's own `~/.pim/subagents`.
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
  });
  gateway.start();
});

afterEach(async () => {
  release?.();
  release = undefined;
  held = undefined;
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
  const finish = holdChild();
  const mark = probe.events.length;
  await probe.prompt("delegate this");
  await probe.waitFor((event) => event.type === "tool_update", { from: mark });

  expect((await probe.watchSubagent(CALL_ID)).success).toBe(true);
  // The header is line 1 of the child's log and projects to nothing, so its
  // first message is seq 2 — the ordinal is the physical line, always.
  expect(seqsOf(watched(probe)[0] ?? [])).toEqual([2]);
  expect(textsOf(watched(probe)[0] ?? [])).toEqual([TASK]);

  finish();
  await probe.waitFor(
    (event) =>
      event.type === "subagent_events" &&
      textsOf(event.events).includes(CHILD_ANSWER),
    { from: mark }
  );
  await idle(probe, mark);

  // Live: the child's answer arrived in its own envelope while the call was
  // still running, not folded into the replay of a settled log. The parent's
  // own `tool_result` is what proves it — the envelope is ahead of it, so it
  // cannot have been a drain that waited for the call to be written down.
  expect(watched(probe)).toHaveLength(2);
  expect(seqsOf(watched(probe)[1] ?? [])).toEqual([3]);
  const answered = probe.events.findIndex(
    (event) =>
      event.type === "subagent_events" &&
      textsOf(event.events).includes(CHILD_ANSWER)
  );
  const written = probe.events.findIndex(
    (event) => event.type === "tool_result" && event.callId === CALL_ID
  );
  expect(answered).toBeGreaterThan(-1);
  expect(written).toBeGreaterThan(answered);
  // The parent's transcript never holds the child's words, whatever they are.
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

test("stops sending a child's events once it is unwatched", async () => {
  const probe = await connect();
  const finish = holdChild();
  const mark = probe.events.length;
  await probe.prompt("delegate this");
  await probe.waitFor((event) => event.type === "tool_update", { from: mark });
  await probe.watchSubagent(CALL_ID);

  expect((await probe.unwatchSubagent(CALL_ID)).success).toBe(true);
  finish();
  // The turn ending is the control: everything the child wrote is on disk and
  // every frame about it has been sent by the time the session goes idle.
  await idle(probe, mark);

  expect(watched(probe)).toHaveLength(1);
});

/**
 * The path is derived from ids, so an id that is a path is the whole attack.
 * Traversal and absolute are refused by the charset; a well-formed id for a
 * run that never happened is refused by the file not being there.
 */
test.each([
  ["../../../etc/passwd", "malformed"],
  ["/etc/passwd", "malformed"],
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

/**
 * A watch is not a second attach: it reads a child of the one session this
 * connection is on, so naming another session is refused rather than served
 * out of that session's directory.
 */
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

/** A child log is not a session: nothing may resume it or list it. */
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
