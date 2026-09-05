import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Type } from "typebox";

import { SessionRegistry } from "#core/session/SessionRegistry";
import { Tools, type PimToolDefinition } from "#core/shared/Tools";
import {
  isDurableEvent,
  type DurableEvent,
  type ServerEvent,
} from "#protocol/ServerEvent";
import { ProbeClient } from "./ProbeClient";
import { WsGateway } from "./WsGateway";

const REPLY = "hello from the gateway";
const TOOL_ARGS = { text: "hi" };
const TOOL_OUTPUT = `pong: ${TOOL_ARGS.text}`;

let tmp: string;
let agentDir: string;
let previousAgentDir: string | undefined;
let modelServer: ReturnType<typeof Bun.serve> | undefined;
let registry: SessionRegistry;
let gateway: WsGateway;
let probes: ProbeClient[] = [];

const pingSchema = Type.Object({ text: Type.String() });

/** A tool with a view that reads `details` only, never the model-facing text. */
function pingTool(): PimToolDefinition<typeof pingSchema, { echoed: string }> {
  return {
    name: "ping",
    label: "ping",
    description: "echo a string back",
    parameters: pingSchema,
    effect: { kind: "readOnly" },
    execute: async (_id, params) => ({
      content: [{ type: "text" as const, text: `pong: ${params.text}` }],
      details: { echoed: params.text },
    }),
    toViewModel: ({ args, result }) => ({
      label: "Ping",
      title: [{ kind: "text", text: args.text ?? "" }],
      ...(result === undefined
        ? {}
        : {
            summary: [
              {
                kind: "kv" as const,
                pairs: [["echoed", result.details.echoed] as const],
              },
            ],
          }),
    }),
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

/** Set by a test to hold the prose turn open until it says otherwise. */
let gate: Promise<void> | undefined;

function holdTurn(): () => void {
  let release!: () => void;
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => {
    gate = undefined;
    release();
  };
}

/**
 * Streams a tool call on the first request of a turn and prose on the second,
 * so one prompt exercises the whole projection: assistant message, tool call,
 * tool result, final text.
 */
function startModelServer(): void {
  let requests = 0;
  modelServer = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      const isToolTurn = requests++ % 2 === 0;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
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
                      name: "ping",
                      arguments: JSON.stringify(TOOL_ARGS),
                    },
                  },
                ],
              })
            );
            encode(chunk({}, "tool_calls"));
          } else {
            for (const word of REPLY.split(" ")) {
              encode(chunk({ content: `${word} ` }));
              await Bun.sleep(20);
            }
            await gate;
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

async function startGateway(): Promise<void> {
  registry = new SessionRegistry({
    defaults: { cwd: tmp, model: "test/echo" },
    agentDir,
    // Pi's ToolDefinition is invariant in its schema, so a concrete one needs a
    // cast to sit in the erased array pi asks for.
    customTools: () => [Tools.wrap(pingTool()) as unknown as ToolDefinition],
  });
  await registry.init();
  gateway = new WsGateway({ registry, port: 0 });
  gateway.start();
}

async function connect(
  options: { readonly sessionId?: string; readonly fromSeq?: number } = {}
): Promise<ProbeClient> {
  const probe = new ProbeClient({
    url: gateway.url,
    cwd: tmp,
    ...options,
  });
  probes.push(probe);
  const attached = await probe.connect();
  expect(attached.success).toBe(true);
  return probe;
}

function durable(probe: ProbeClient): readonly DurableEvent[] {
  return probe.events.filter(isDurableEvent);
}

function idle(probe: ProbeClient, from: number): Promise<ServerEvent> {
  return probe.waitFor(
    (event) => event.type === "session_state" && event.status === "idle",
    { from, timeoutMs: 20_000 }
  );
}

beforeEach(async () => {
  startModelServer();
  tmp = await mkdtemp(join(tmpdir(), "pim-gateway-test-"));
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
  await rm(tmp, { recursive: true, force: true });
});

test("starts a session, prompts, and streams the whole turn", async () => {
  const probe = await connect();
  expect(probe.sessionId).toBeString();

  const mark = probe.events.length;
  await probe.prompt("say hello");
  await idle(probe, mark);

  const events = durable(probe);
  const messages = events.filter((e) => e.type === "message");
  expect(messages.map((m) => m.type === "message" && m.role)).toEqual([
    "user",
    "assistant",
    "assistant",
  ]);
  const user = messages[0];
  expect(user?.type === "message" && user.text).toBe("say hello");
  const final = messages.at(-1);
  expect(final?.type === "message" && final.text.trim()).toBe(REPLY);

  const call = messages[1];
  expect(call?.type === "message" && call.toolCalls?.[0]?.name).toBe("ping");
  const result = events.find((e) => e.type === "tool_result");
  expect(result?.type === "tool_result" && result.callId).toBe("call_1");
  expect(result?.type === "tool_result" && result.view.summary).toEqual([
    { kind: "kv", pairs: [["echoed", "hi"]] },
  ]);

  expect(probe.events.some((e) => e.type === "text_delta")).toBe(true);
  expect(probe.events.some((e) => e.type === "tool_call")).toBe(true);
  expect(probe.events.some((e) => e.type === "turn_end")).toBe(true);
  expect(events.map((e) => e.seq)).toEqual(
    events.map((e) => e.seq).sort((a, b) => a - b)
  );
});

test("never forwards raw tool content to a client", async () => {
  const probe = await connect();
  const mark = probe.events.length;
  await probe.prompt("say hello");
  await idle(probe, mark);

  const dump = probe.events.map((e) => JSON.stringify(e)).join("\n");
  expect(dump).not.toContain(TOOL_OUTPUT);
  expect(dump).not.toContain('"content"');
});

test("loses nothing when a probe dies mid-turn and resumes by seq", async () => {
  const first = await connect();
  const sessionId = first.sessionId!;
  const mark = first.events.length;
  await first.prompt("say hello");
  await first.waitFor((e) => e.type === "text_delta", { from: mark });
  first.kill();
  const resumeSeq = first.seq;

  const second = await connect({ sessionId, fromSeq: resumeSeq });
  const tail = durable(second);
  expect(tail.every((e) => e.seq > resumeSeq)).toBe(true);
  await idle(second, second.events.length);

  const seen = [...durable(first), ...durable(second)];
  const seqs = seen.map((e) => e.seq);
  expect(seqs).toEqual([...new Set(seqs)].sort((a, b) => a - b));

  const missed = durable(second)
    .filter((e) => e.type === "message")
    .at(-1);
  expect(missed).toMatchObject({ role: "assistant" });
  expect(missed?.type === "message" && missed.text.trim()).toBe(REPLY);

  const complete = await connect({ sessionId, fromSeq: 0 });
  expect(durable(complete).map((e) => e.seq)).toEqual(seqs);
  expect(durable(complete)).toEqual(seen);
});

test("hands a reconnecting client the in-flight turn as one block", async () => {
  const release = holdTurn();
  const first = await connect();
  const sessionId = first.sessionId!;
  const mark = first.events.length;
  await first.prompt("say hello");
  await first.waitFor((e) => e.type === "text_delta", { from: mark });
  first.kill();

  const second = await connect({ sessionId, fromSeq: first.seq });
  const deltas = second.events.filter((e) => e.type === "text_delta");
  expect(deltas).toHaveLength(1);
  expect(REPLY).toStartWith(deltas[0]!.delta.trim());
  expect(second.events.filter((e) => e.type === "message_start")).toHaveLength(
    1
  );

  release();
  await idle(second, second.events.length);
  const final = durable(second)
    .filter((e) => e.type === "message")
    .at(-1);
  expect(final?.type === "message" && final.text.trim()).toBe(REPLY);
});

test("two probes attached at once see identical durable streams", async () => {
  const first = await connect();
  const second = await connect({ sessionId: first.sessionId! });

  const marks = [first.events.length, second.events.length] as const;
  await first.prompt("say hello");
  await Promise.all([idle(first, marks[0]), idle(second, marks[1])]);

  expect(durable(second)).toEqual(durable(first));
  const live = (probe: ProbeClient): readonly ServerEvent[] =>
    probe.events.filter(
      (event) =>
        !isDurableEvent(event) &&
        event.type !== "response" &&
        event.type !== "attached"
    );
  expect(live(second)).toEqual(live(first));
});

test("finishes a turn with zero clients attached", async () => {
  const starter = await connect();
  const sessionId = starter.sessionId!;
  await starter.prompt("say hello");
  starter.kill();

  const host = registry.peek(sessionId)!;
  while (host.status !== "idle" || host.isStreaming) {
    await Bun.sleep(25);
  }
  await Bun.sleep(50);

  const late = await connect({ sessionId, fromSeq: 0 });
  const messages = durable(late).filter((e) => e.type === "message");
  const final = messages.at(-1);
  expect(final?.type === "message" && final.text.trim()).toBe(REPLY);
  expect(durable(late).some((e) => e.type === "tool_result")).toBe(true);
});

test("survives a restart with sessions resumable from disk", async () => {
  const probe = await connect();
  const sessionId = probe.sessionId!;
  const mark = probe.events.length;
  await probe.prompt("say hello");
  await idle(probe, mark);
  const before = durable(probe);
  probe.close();

  await gateway.stop();
  await registry.disposeAll();
  await startGateway();

  const after = await connect({ sessionId, fromSeq: 0 });
  expect(durable(after)).toEqual(before);
});

test("lists pi's sessions, before any attach and after one", async () => {
  const probe = await connect();
  const sessionId = probe.sessionId!;
  const mark = probe.events.length;
  await probe.prompt("say hello");
  await idle(probe, mark);

  const listed = await probe.listSessions();
  expect(listed.map((row) => row.sessionId)).toContain(sessionId);
  const mine = listed.find((row) => row.sessionId === sessionId)!;
  expect(mine.cwd).toBe(tmp);
  expect(mine.modifiedAt).toBeGreaterThan(0);
  // Named by its opening message, and carrying the head a client compares
  // against what it has already painted.
  expect(mine.title).toBe("say hello");
  expect(mine.head).toBeGreaterThan(0);
  // The catalogue is pi's directory layout, not a store of ours.
  expect(Object.keys(mine).sort()).toEqual([
    "createdAt",
    "cwd",
    "head",
    "modifiedAt",
    "sessionId",
    "title",
  ]);

  expect(await probe.listSessions("/nowhere")).toEqual([]);

  // Picking a session is what a client does instead of already having one, so
  // this is the one command that answers without an attach.
  const socket = new WebSocket(gateway.url);
  await new Promise((resolve) => socket.addEventListener("open", resolve));
  const answer = new Promise<string>((resolve) => {
    socket.addEventListener("message", (event) => {
      resolve(String(event.data));
    });
  });
  socket.send(JSON.stringify({ id: "1", type: "list_sessions" }));
  const response = JSON.parse(await answer) as {
    readonly success: boolean;
    readonly sessions: readonly { readonly sessionId: string }[];
  };
  expect(response.success).toBe(true);
  expect(response.sessions.map((row) => row.sessionId)).toContain(sessionId);
  socket.close();
});

test("answers with the model catalogue and this model's thinking levels", async () => {
  const probe = await connect();

  const { models, thinkingLevels } = await probe.listModels();
  expect(models).toEqual([{ id: "test/echo", label: "echo" }]);
  // The levels belong to the model the session is on, so they only exist
  // once this connection has one.
  expect(thinkingLevels).toBeArray();
});

test("session state carries context usage and the cwd's git branch", async () => {
  Bun.spawnSync(["git", "init", "-q", "-b", "trunk"], { cwd: tmp });

  const probe = await connect();
  const mark = probe.events.length;
  await probe.prompt("say hello");
  await idle(probe, mark);

  // The branch is read behind the caller — `sessionState()` is synchronous
  // and git is not — so it lands on a later state than the first one.
  const state = await probe.waitFor(
    (event) => event.type === "session_state" && event.branch !== undefined,
    { from: mark }
  );
  expect(state.type === "session_state" && state.branch).toBe("trunk");
  expect(state.type === "session_state" && state.dirty).toBe(true);

  const usage = probe.events.findLast(
    (event) =>
      event.type === "session_state" && event.contextWindow !== undefined
  );
  expect(usage?.type === "session_state" && usage.contextWindow).toBe(8192);
  expect(usage?.type === "session_state" && usage.contextPercent).toBeNumber();
});

test("rejects a client speaking another protocol version", async () => {
  const probe = new ProbeClient({
    url: gateway.url,
    cwd: tmp,
    protocolVersion: 999,
  });
  probes.push(probe);

  const response = await probe.connect();
  expect(response.success).toBe(false);
  expect(response.error).toContain("unsupported protocol version 999");
  expect(await probe.closed()).toEqual({
    code: 4001,
    reason: "protocol version mismatch",
  });
});

test("refuses commands before an attach", async () => {
  const probe = new ProbeClient({ url: gateway.url });
  probes.push(probe);
  const socket = new WebSocket(gateway.url);
  await new Promise((resolve) => socket.addEventListener("open", resolve));
  const seen = new Promise<string>((resolve) => {
    socket.addEventListener("message", (event) => {
      resolve(String(event.data));
    });
  });
  socket.send(
    JSON.stringify({ id: "1", type: "cancel", sessionId: "whatever" })
  );
  expect(JSON.parse(await seen)).toEqual({
    type: "response",
    id: "1",
    success: false,
    error: "not attached: send `attach` first",
  });
  socket.close();
});
