import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Type } from "typebox";

import { SessionRegistry } from "#core/session/SessionRegistry";
import { Tools, type PimToolDefinition } from "#core/shared/Tools";
import { isDurableEvent, type ServerEvent } from "#protocol/ServerEvent";
import { ProbeClient } from "./ProbeClient";
import { WsGateway } from "./WsGateway";

const REPLY = "all done";

let tmp: string;
let cwd: string;
let agentDir: string;
let previousAgentDir: string | undefined;
let modelServer: ReturnType<typeof Bun.serve> | undefined;
let registry: SessionRegistry;
let gateway: WsGateway;
let probes: ProbeClient[] = [];
/** The tool call the stub model asks for on the next turn it starts. */
let nextCall: { readonly name: string; readonly args: unknown };

const writeSchema = Type.Object({ path: Type.String() });
const shellSchema = Type.Object({ command: Type.String() });

/** Tier 2: bounded by the path it declares. */
function writeTool(): PimToolDefinition<typeof writeSchema, { path: string }> {
  return {
    name: "put_file",
    label: "put_file",
    description: "create a file",
    parameters: writeSchema,
    effect: { kind: "writesPaths", paths: ({ path }) => [path] },
    execute: async (_id, params) => {
      const target = join(cwd, params.path);
      await mkdir(dirname(target), { recursive: true });
      await Bun.write(target, "written\n");
      return {
        content: [{ type: "text" as const, text: `wrote ${params.path}` }],
        details: { path: params.path },
      };
    },
  };
}

/** Tier 3: the arguments say nothing about what it will touch. */
function shellTool(): PimToolDefinition<typeof shellSchema, { ran: string }> {
  return {
    name: "shell",
    label: "shell",
    description: "run a command",
    parameters: shellSchema,
    effect: { kind: "unbounded" },
    execute: async (_id, params) => {
      await Bun.write(marker(), params.command);
      return {
        content: [{ type: "text" as const, text: `ran ${params.command}` }],
        details: { ran: params.command },
      };
    },
  };
}

function marker(): string {
  return join(tmp, "marker.txt");
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

/** Calls a tool, then answers in prose once it sees the tool's result. */
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
                    id: "call_1",
                    type: "function",
                    function: {
                      name: nextCall.name,
                      arguments: JSON.stringify(nextCall.args),
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

async function connect(
  options: { readonly sessionId?: string; readonly fromSeq?: number } = {}
): Promise<ProbeClient> {
  const probe = new ProbeClient({ url: gateway.url, cwd, ...options });
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

function approvalRequest(
  probe: ProbeClient,
  from = 0
): Promise<ServerEvent & { readonly type: "approval_request" }> {
  return probe.waitFor((event) => event.type === "approval_request", {
    from,
    timeoutMs: 20_000,
  }) as Promise<ServerEvent & { readonly type: "approval_request" }>;
}

function exists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

beforeEach(async () => {
  startModelServer();
  tmp = await mkdtemp(join(tmpdir(), "pim-approval-gateway-"));
  cwd = join(tmp, "work");
  agentDir = join(tmp, "agent");
  await mkdir(cwd, { recursive: true });
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
    defaults: { cwd, model: "test/echo" },
    agentDir,
    customTools: () => [
      Tools.wrap(writeTool()) as unknown as ToolDefinition,
      Tools.wrap(shellTool()) as unknown as ToolDefinition,
    ],
  });
  await registry.init();
  gateway = new WsGateway({ registry, port: 0 });
  gateway.start();
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
  await rm(tmp, { recursive: true, force: true });
});

test("tier 2: a write inside the cwd runs unattended", async () => {
  nextCall = { name: "put_file", args: { path: "nested/inside.txt" } };
  const probe = await connect();
  const mark = probe.events.length;
  await probe.prompt("make a file");
  await idle(probe, mark);

  expect(probe.events.some((e) => e.type === "approval_request")).toBe(false);
  expect(await exists(join(cwd, "nested/inside.txt"))).toBe(true);
});

test("tier 2 escapes the cwd and becomes a question", async () => {
  nextCall = { name: "put_file", args: { path: "../escaped.txt" } };
  const probe = await connect();
  const mark = probe.events.length;
  await probe.prompt("make a file outside");

  const request = await approvalRequest(probe, mark);
  expect(request.name).toBe("put_file");
  expect(request.reason).toContain("outside");
  expect(await exists(join(tmp, "escaped.txt"))).toBe(false);

  expect((await probe.approve(request.callId)).success).toBe(true);
  await idle(probe, mark);
  expect(await exists(join(tmp, "escaped.txt"))).toBe(true);
});

test("tier 3: two clients see the question and the first answer wins", async () => {
  nextCall = { name: "shell", args: { command: "rm -rf /" } };
  const first = await connect();
  const second = await connect({ sessionId: first.sessionId! });
  const marks = [first.events.length, second.events.length] as const;
  await first.prompt("do something drastic");

  const request = await approvalRequest(first, marks[0]);
  const seenBySecond = await approvalRequest(second, marks[1]);
  expect(seenBySecond.callId).toBe(request.callId);
  expect(request.reason).toContain("shell");

  expect(await first.approve(request.callId)).toMatchObject({ success: true });
  const late = await second.approve(request.callId, false);
  expect(late.success).toBe(false);
  expect(late.error).toContain("already resolved");

  for (const probe of [first, second]) {
    const resolved = probe.events.filter((e) => e.type === "approval_resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      callId: request.callId,
      approved: true,
    });
  }
  await idle(first, marks[0]);
  expect(await exists(marker())).toBe(true);
});

test("a denial blocks the tool and lets the turn finish", async () => {
  nextCall = { name: "shell", args: { command: "rm -rf /" } };
  const probe = await connect();
  const mark = probe.events.length;
  await probe.prompt("do something drastic");

  const request = await approvalRequest(probe, mark);
  expect((await probe.approve(request.callId, false)).success).toBe(true);
  await idle(probe, mark);

  expect(await exists(marker())).toBe(false);
  const results = probe.events
    .filter(isDurableEvent)
    .filter((e) => e.type === "tool_result");
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ isError: true });
  const messages = probe.events
    .filter(isDurableEvent)
    .filter((e) => e.type === "message");
  expect(messages.at(-1)).toMatchObject({ role: "assistant", text: REPLY });
});

test("parks with nobody attached and resolves when a client turns up", async () => {
  nextCall = { name: "shell", args: { command: "rm -rf /" } };
  const starter = await connect();
  const sessionId = starter.sessionId!;
  await starter.prompt("do something drastic");
  starter.kill();

  // The question outlives the connection that provoked it: a client attaching
  // later is handed it in the in-flight snapshot.
  const late = await connect({ sessionId, fromSeq: 0 });
  const request = await approvalRequest(late);
  expect(await exists(marker())).toBe(false);

  const mark = late.events.length;
  expect((await late.approve(request.callId)).success).toBe(true);
  await idle(late, mark);
  expect(await exists(marker())).toBe(true);
  const messages = late.events
    .filter(isDurableEvent)
    .filter((e) => e.type === "message");
  expect(messages.at(-1)).toMatchObject({ role: "assistant", text: REPLY });
});

test("cancelling a parked turn releases it instead of deadlocking", async () => {
  nextCall = { name: "shell", args: { command: "rm -rf /" } };
  const probe = await connect();
  const mark = probe.events.length;
  await probe.prompt("do something drastic");
  await approvalRequest(probe, mark);

  expect(
    (await probe.send({ type: "cancel", sessionId: probe.sessionId! })).success
  ).toBe(true);
  await idle(probe, mark);
  expect(await exists(marker())).toBe(false);

  // The session is still usable afterwards.
  nextCall = { name: "put_file", args: { path: "after-cancel.txt" } };
  const second = probe.events.length;
  await probe.prompt("make a file");
  await idle(probe, second);
  expect(await exists(join(cwd, "after-cancel.txt"))).toBe(true);
});

test("one parked session does not stall another", async () => {
  nextCall = { name: "shell", args: { command: "rm -rf /" } };
  const parked = await connect();
  const parkedMark = parked.events.length;
  await parked.prompt("do something drastic");
  const request = await approvalRequest(parked, parkedMark);

  nextCall = { name: "put_file", args: { path: "other-session.txt" } };
  const other = await connect();
  expect(other.sessionId).not.toBe(parked.sessionId);
  const otherMark = other.events.length;
  await other.prompt("make a file");
  await idle(other, otherMark);
  expect(await exists(join(cwd, "other-session.txt"))).toBe(true);

  expect(parked.events.some((e) => e.type === "approval_resolved")).toBe(false);
  await parked.approve(request.callId, false);
  await idle(parked, parkedMark);
});
