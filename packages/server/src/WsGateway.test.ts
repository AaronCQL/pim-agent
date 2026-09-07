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
  type ResponseEvent,
  type ServerEvent,
} from "#protocol/ServerEvent";
import { ProbeClient } from "./ProbeClient";
import { WsGateway } from "./WsGateway";

const REPLY = "hello from the gateway";
/** The first step's reasoning and prose, which stream before any tool runs. */
const REASONING = "the user wants a ping, so call the tool";
const PROSE = "Pinging the tool now.";
const TOOL_ARGS = { text: "hi" };
const TOOL_OUTPUT = `pong: ${TOOL_ARGS.text}`;
/**
 * Yields between chunks so each delta reaches the client as its own frame
 * rather than one batched write. Only the interleaving matters, never the
 * duration — a test that needs a turn held open mid-stream uses `holdTurn`.
 */
const TOKEN_DELAY_MS = 1;

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
 * Streams reasoning, prose and a tool call on the first request of a turn and
 * prose on the second, so one prompt exercises the whole projection and the
 * whole live turn: two assistant messages, a call, a result, a final text.
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
            for (const word of REASONING.split(" ")) {
              encode(chunk({ reasoning_content: `${word} ` }));
            }
            for (const word of PROSE.split(" ")) {
              encode(chunk({ content: `${word} ` }));
            }
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
              await Bun.sleep(TOKEN_DELAY_MS);
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

/** Polls, because a prompt is accepted long before pi has queued it. */
async function until(ready: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await Bun.sleep(1);
  }
}

/** The texts of the durable user messages, in the order pi wrote them. */
function saidBy(probe: ProbeClient): readonly string[] {
  return durable(probe)
    .filter((event) => event.type === "message" && event.role === "user")
    .map((event) => (event.type === "message" ? event.text : ""));
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

/**
 * A turn is a model call per step, and pi writes the entry for a step long
 * after it streamed — here, not until the turn settles. So every step has to
 * be live in its own right: one `message_start` each, its own reasoning and
 * prose, and the calls it made hung off it.
 */
test("streams a step at a time, reasoning included", async () => {
  const probe = await connect();
  const mark = probe.events.length;
  await probe.prompt("say hello with a tool");
  await idle(probe, mark);

  const live = probe.events.slice(mark);
  const steps = live.filter((e) => e.type === "message_start");
  expect(steps).toHaveLength(2);

  const streamed = (type: "text_delta" | "thinking_delta", id: string) =>
    live
      .filter((e) => e.type === type && e.messageId === id)
      .map((e) => (e.type === type ? e.delta : ""))
      .join("")
      .trim();
  const [first, second] = steps.map((e) =>
    e.type === "message_start" ? e.messageId : ""
  );
  expect(streamed("thinking_delta", first!)).toBe(REASONING);
  // The prose of the step that called the tool: the thing a single-slot
  // bucket used to drop the moment the next step started.
  expect(streamed("text_delta", first!)).toBe(PROSE);
  expect(streamed("text_delta", second!)).toBe(REPLY);

  const call = live.find((e) => e.type === "tool_call");
  expect(call?.type === "tool_call" && call.messageId).toBe(first!);
  // Settled live, not left spinning until pi appends the result.
  const end = live.find((e) => e.type === "tool_end");
  expect(end?.type === "tool_end" && end.isError).toBe(false);
  expect(live.indexOf(end!)).toBeLessThan(live.indexOf(steps[1]!));
});

test("hands a reconnecting client every step of the in-flight turn", async () => {
  const release = holdTurn();
  const first = await connect();
  const sessionId = first.sessionId!;
  const mark = first.events.length;
  await first.prompt("say hello");
  // The gate holds the *second* step open, so that is the one the reconnect
  // has to land in. The first step streams prose too, and only this step's
  // words are a prefix of `REPLY`, so waiting on any delta was waiting on the
  // first step being quicker than this line.
  await first.waitFor(
    (e) => e.type === "text_delta" && REPLY.startsWith(e.delta.trim()),
    { from: mark }
  );
  // The step that finished is a line in the log already, result and all —
  // pi wrote it when it ended, and the client is told then rather than when
  // the run settles.
  await first.waitFor((e) => e.type === "tool_result", { from: mark });
  const step = durable(first).find(
    (e) => e.type === "message" && e.role === "assistant"
  );
  expect(step?.type === "message" && step.toolCalls?.length).toBe(1);
  first.kill();

  const second = await connect({ sessionId, fromSeq: first.seq });
  // Only the step still streaming comes back live, and it carries at most one
  // coalesced delta: the deltas themselves were never persisted, so this is
  // the only shape they can come back in.
  const starts = second.events.filter((e) => e.type === "message_start");
  const deltas = second.events.filter((e) => e.type === "text_delta");
  expect(new Set(starts.map((e) => e.messageId)).size).toBe(starts.length);
  expect(deltas.length).toBeLessThanOrEqual(starts.length);
  expect(REPLY).toStartWith(deltas.at(-1)!.delta.trim());
  // And the finished step is not sent twice: the client read it from the log
  // before it died, so what comes back is the turn's remainder, not a live
  // copy of a row it already has.
  expect(second.events.some((e) => e.type === "tool_call")).toBe(false);

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
    await Bun.sleep(1);
  }

  const late = await connect({ sessionId, fromSeq: 0 });
  const messages = durable(late).filter((e) => e.type === "message");
  const final = messages.at(-1);
  expect(final?.type === "message" && final.text.trim()).toBe(REPLY);
  expect(durable(late).some((e) => e.type === "tool_result")).toBe(true);
});

test("says which sessions are working, to clients attached elsewhere", async () => {
  const worker = await connect();
  const sessionId = worker.sessionId!;
  // Once around, so pi has written the session and the catalogue can answer
  // for it: a client that arrives mid-turn reads the row, not the stream.
  const first = worker.events.length;
  await worker.prompt("say hello");
  await idle(worker, first);

  const watcher = await connect();
  expect(watcher.sessionId).not.toBe(sessionId);

  const release = holdTurn();
  const mark = watcher.events.length;
  await worker.prompt("say hello again");
  const started = await watcher.waitFor(
    (event) =>
      event.type === "session_activity" && event.sessionId === sessionId,
    { from: mark }
  );
  expect(started.type === "session_activity" && started.status).not.toBe(
    "idle"
  );

  // The same answer for a client that arrives mid-turn, which has no frame to
  // have missed and only the catalogue to go on.
  const during = await watcher.listSessions();
  expect(
    during.find((row) => row.sessionId === sessionId)?.status
  ).toBeDefined();

  release();
  await watcher.waitFor(
    (event) =>
      event.type === "session_activity" &&
      event.sessionId === sessionId &&
      event.status === "idle",
    { from: mark }
  );
  // A session doing nothing is not marked at all: the row it draws is a row
  // about a file, and a file is never working.
  const after = await watcher.listSessions();
  expect(
    after.find((row) => row.sessionId === sessionId)?.status
  ).toBeUndefined();
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
  expect(models).toEqual([
    { id: "test/echo", label: "echo", provider: "test" },
  ]);
  // The same name the state event carries, so a client can title its picker
  // without waiting for the catalogue.
  const state = probe.events.findLast(
    (event) => event.type === "session_state"
  );
  expect(state?.type === "session_state" && state.modelLabel).toBe("echo");
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
  expect(
    state.type === "session_state" && (state.dirtyCount ?? 0) > 0
  ).toBeTrue();

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

/**
 * Two messages said into the same running turn are one steer, not two turns
 * apart. One entry, not two: the gateway merges so that a client has one
 * thing to take back, which is what makes a queued message editable.
 */
test("a message said into a running turn steers it, merged into one", async () => {
  const probe = await connect();
  const release = holdTurn();
  const mark = probe.events.length;
  try {
    await probe.prompt("say hello");
    await probe.waitFor((event) => event.type === "text_delta", { from: mark });
    const agent = registry.peek(probe.sessionId!)!.agentSession!;

    await probe.prompt("steer me");
    await until(() => agent.pendingMessageCount === 1, "the queued steer");
    await probe.prompt("and then this");
    await until(
      () => agent.getSteeringMessages()[0]?.includes("and then this") === true,
      "the second message to join the first"
    );
    expect(agent.pendingMessageCount).toBe(1);
    expect(agent.getSteeringMessages()).toEqual(["steer me\n\nand then this"]);
  } finally {
    release();
  }

  // Delivered as one user message, in the turn it was said into.
  await until(
    () => saidBy(probe).length === 2,
    "the queued message to be delivered"
  );
  expect(saidBy(probe)).toEqual(["say hello", "steer me\n\nand then this"]);
});

/**
 * A turn held open with one message waiting behind it, reclaimed by the
 * command under test and then let go.
 */
async function reclaim(
  type: "cancel" | "dequeue"
): Promise<{ probe: ProbeClient; mark: number; response: ResponseEvent }> {
  const probe = await connect();
  const release = holdTurn();
  const mark = probe.events.length;
  try {
    await probe.prompt("say hello");
    await probe.waitFor((e) => e.type === "text_delta", { from: mark });
    const agent = registry.peek(probe.sessionId!)!.agentSession!;
    await probe.prompt("steer me");
    await until(() => agent.pendingMessageCount === 1, "the queued steer");

    const response = await probe.send({ type, sessionId: probe.sessionId! });
    return { probe, mark, response };
  } finally {
    release();
  }
}

test("cancelling hands back what the turn was still holding", async () => {
  const { probe, mark, response } = await reclaim("cancel");

  expect(response.success).toBe(true);
  expect(response.restored).toEqual(["steer me"]);
  await idle(probe, mark);
  // Never said, so never written: a message queued behind a turn that was
  // killed belongs back in the client's box, not in the conversation.
  expect(saidBy(probe)).toEqual(["say hello"]);
});

test("taking the queued message back leaves the turn running", async () => {
  const { probe, mark, response } = await reclaim("dequeue");

  expect(response.success).toBe(true);
  expect(response.restored).toEqual(["steer me"]);
  // The turn ran to its own end, and said only what it was told before the
  // reader thought better of the rest.
  await idle(probe, mark);
  expect(saidBy(probe)).toEqual(["say hello"]);
});
