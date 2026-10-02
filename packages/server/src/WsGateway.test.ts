import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Type } from "typebox";

import { makeRepo } from "#core/shared/fixtures/repo";
import type { CommandDraft } from "#protocol/Command";
import { SessionFixture } from "#core/session/fixtures/SessionFixture";
import { SessionRegistry } from "#core/session/SessionRegistry";
import { Tools, type PimToolDefinition } from "#core/shared/Tools";
import {
  isDurableEvent,
  type DurableEvent,
  type ResponseEvent,
  type ServerEvent,
  type SessionSummaryView,
} from "#protocol/ServerEvent";
import { ProbeClient } from "./ProbeClient";
import { WsGateway } from "./WsGateway";
import { until } from "#core/shared/fixtures/wait";

const REPLY = "hello from the gateway";
const REASONING = "the user wants a ping, so call the tool";
const PROSE = "Pinging the tool now.";
const TOOL_ARGS = { text: "hi" };
const TOOL_OUTPUT = `pong: ${TOOL_ARGS.text}`;
/** Yields between chunks so each delta is its own frame. */
const TOKEN_DELAY_MS = 1;

let tmp: string;
let agentDir: string;
let previousAgentDir: string | undefined;
let modelServer: ReturnType<typeof Bun.serve> | undefined;
let registry: SessionRegistry;
let gateway: WsGateway;
let probes: ProbeClient[] = [];

const pingSchema = Type.Object({ text: Type.String() });

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

/** Holds the prose turn open; also cleared in `afterEach` so a failed test can't stall the next. */
let gate: Promise<void> | undefined;
let openGate: (() => void) | undefined;

/** Makes the provider refuse every call with a non-retryable error. */
let refusal: string | undefined;

function holdTurn(): () => void {
  let release!: () => void;
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  openGate = release;
  return releaseTurn;
}

function releaseTurn(): void {
  gate = undefined;
  openGate?.();
  openGate = undefined;
}

/** First request: reasoning, prose and a tool call. Second: prose. */
function startModelServer(): void {
  let requests = 0;
  modelServer = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      if (refusal !== undefined) {
        return new Response(refusal, { status: 400 });
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
    // ToolDefinition is invariant in its schema, hence the cast.
    customTools: () => [Tools.wrap(pingTool()) as unknown as ToolDefinition],
  });
  await registry.init();
  gateway = new WsGateway({
    registry,
    port: 0,
    readCursorsPath: join(tmp, "read.json"),
    sessionMetaPath: join(tmp, "sessions.json"),
  });
  gateway.start();
}

async function connect(
  options: {
    readonly sessionId?: string;
    readonly fromSeq?: number;
    readonly attentive?: boolean;
  } = {}
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

/**
 * Waits for the turn to end. An idle event only counts if the host is idle too:
 * the git watcher can push a stale idle state before the turn starts.
 */
async function idle(probe: ProbeClient, from: number): Promise<ServerEvent> {
  let cursor = from;
  for (;;) {
    const event = await probe.waitFor(
      (candidate) =>
        candidate.type === "session_state" && candidate.status === "idle",
      { from: cursor, timeoutMs: 20_000 }
    );
    const host = registry.peek(probe.sessionId ?? "");
    if (host === undefined || host.status === "idle") {
      return event;
    }
    // Stale; only a later event can end this turn.
    cursor = probe.events.length;
  }
}

/**
 * Prompts and waits until the turn is running. The ack arrives before pi
 * queues the turn, so waiting for idle right after could see the calm before it.
 */
async function prompt(
  probe: ProbeClient,
  text: string,
  from: number
): Promise<void> {
  await probe.prompt(text);
  await probe.waitFor(
    (event) => event.type === "session_state" && event.status !== "idle",
    { from, timeoutMs: 20_000 }
  );
}

function saidBy(probe: ProbeClient): readonly string[] {
  return durable(probe)
    .filter((event) => event.type === "message" && event.role === "user")
    .map((event) => (event.type === "message" ? event.text : ""));
}

/** Absent means read. */
function unreadIn(
  rows: readonly SessionSummaryView[],
  sessionId: string
): boolean | undefined {
  return rows.find((row) => row.sessionId === sessionId)?.unread;
}

async function writeSession(
  id: string,
  repliedAt: string,
  saidAt?: string
): Promise<void> {
  await SessionFixture.write({ agentDir, id, cwd: tmp, repliedAt, saidAt });
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
  releaseTurn();
  refusal = undefined;
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
  await prompt(probe, "say hello", mark);
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
  await prompt(probe, "say hello", mark);
  await idle(probe, mark);

  const dump = probe.events.map((e) => JSON.stringify(e)).join("\n");
  expect(dump).not.toContain(TOOL_OUTPUT);
  expect(dump).not.toContain('"content"');
});

test("says why a turn the provider refused stopped", async () => {
  refusal = "invalid_request_error: this key cannot use that model";
  const probe = await connect();
  const mark = probe.events.length;
  await prompt(probe, "say hello", mark);
  await idle(probe, mark);

  const dead = durable(probe).find(
    (event) => event.type === "message" && event.role === "assistant"
  );
  expect(dead?.type === "message" && dead.error).toContain(refusal);

  // Persisted, so a later attach replays it too.
  const later = await connect({ sessionId: probe.sessionId!, fromSeq: 0 });
  expect(durable(later)).toEqual(durable(probe));
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

test("streams a step at a time, reasoning included", async () => {
  const probe = await connect();
  const mark = probe.events.length;
  await prompt(probe, "say hello with a tool", mark);
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
  expect(streamed("text_delta", first!)).toBe(PROSE);
  expect(streamed("text_delta", second!)).toBe(REPLY);

  const call = live.find((e) => e.type === "tool_call");
  expect(call?.type === "tool_call" && call.messageId).toBe(first!);
  // Settled live, before pi appends the result.
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
  // The gate holds the second step; only its words are a prefix of `REPLY`.
  await first.waitFor(
    (e) => e.type === "text_delta" && REPLY.startsWith(e.delta.trim()),
    { from: mark }
  );
  // The finished step is already in the log.
  await first.waitFor((e) => e.type === "tool_result", { from: mark });
  const step = durable(first).find(
    (e) => e.type === "message" && e.role === "assistant"
  );
  expect(step?.type === "message" && step.toolCalls?.length).toBe(1);
  first.kill();

  const second = await connect({ sessionId, fromSeq: first.seq });
  // Only the streaming step comes back live, once. Delta frame count is not asserted.
  const starts = second.events.filter((e) => e.type === "message_start");
  const deltas = second.events.filter((e) => e.type === "text_delta");
  expect(new Set(starts.map((e) => e.messageId)).size).toBe(starts.length);
  expect(starts.length).toBe(1);
  const streamed = deltas
    .map((e) => e.delta)
    .join("")
    .trim();
  expect(streamed.length).toBeGreaterThan(0);
  expect(REPLY).toStartWith(streamed);
  // The finished step is not sent twice.
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
        event.type !== "attached" &&
        // Server-wide events vary with arrival time.
        event.type !== "session_read"
    );
  expect(live(second)).toEqual(live(first));
});

test("finishes a turn with zero clients attached", async () => {
  const starter = await connect();
  const sessionId = starter.sessionId!;
  await starter.prompt("say hello");
  starter.kill();

  const host = registry.peek(sessionId)!;
  // Wait for the reply on disk: a queued turn is idle too.
  const settled = async (): Promise<boolean> => {
    const path = host.settings.sessionPath;
    if (path === undefined || host.status !== "idle" || host.isStreaming) {
      return false;
    }
    // Pi only writes the file after the first assistant message.
    const text = await Bun.file(path)
      .text()
      .catch(() => "");
    return text.includes(REPLY);
  };
  while (!(await settled())) {
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
  // One turn first, so the session is on disk for the catalogue.
  const first = worker.events.length;
  await prompt(worker, "say hello", first);
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

  // Same for a client that arrives mid-turn.
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
  // An idle session has no status.
  const after = await watcher.listSessions();
  expect(
    after.find((row) => row.sessionId === sessionId)?.status
  ).toBeUndefined();
});

test("dates a session by its last completed turn, and holds that while one runs", async () => {
  const worker = await connect();
  const sessionId = worker.sessionId!;
  const first = worker.events.length;
  await prompt(worker, "say hello", first);
  await idle(worker, first);

  const watcher = await connect();
  const settled = (rows: readonly SessionSummaryView[]): number =>
    rows.find((row) => row.sessionId === sessionId)!.settledAt;
  const before = settled(await watcher.listSessions());

  const release = holdTurn();
  const mark = watcher.events.length;
  await worker.prompt("say hello again");
  await watcher.waitFor(
    (event) =>
      event.type === "session_activity" &&
      event.sessionId === sessionId &&
      event.status !== "idle",
    { from: mark }
  );

  // Mid-turn the file mtime has moved, but the row must not.
  expect(settled(await watcher.listSessions())).toBe(before);

  release();
  await watcher.waitFor(
    (event) =>
      event.type === "session_activity" &&
      event.sessionId === sessionId &&
      event.status === "idle",
    { from: mark }
  );

  expect(settled(await watcher.listSessions())).toBeGreaterThan(before);
});

test("goes unread when a turn ends, and not on the lines it ends with", async () => {
  const worker = await connect();
  const sessionId = worker.sessionId!;
  const first = worker.events.length;
  await prompt(worker, "say hello", first);
  await idle(worker, first);

  // Read: a client is attached. The cursor is server-side, so another client agrees.
  const watcher = await connect();
  expect(unreadIn(await watcher.listSessions(), sessionId)).toBeUndefined();

  const release = holdTurn();
  const mark = watcher.events.length;
  await worker.prompt("say hello again");
  await watcher.waitFor(
    (event) =>
      event.type === "session_activity" &&
      event.sessionId === sessionId &&
      event.status !== "idle",
    { from: mark }
  );
  worker.close();

  // Unattended and mid-turn: not unread until the turn ends.
  expect(unreadIn(await watcher.listSessions(), sessionId)).toBeUndefined();

  release();
  await watcher.waitFor(
    (event) =>
      event.type === "session_activity" &&
      event.sessionId === sessionId &&
      event.status === "idle",
    { from: mark }
  );
  expect(unreadIn(await watcher.listSessions(), sessionId)).toBe(true);

  // Opening it in one client clears it for all.
  const reader = await connect({ sessionId, fromSeq: 0 });
  expect(reader.sessionId).toBe(sessionId);
  await watcher.waitFor(
    (event) => event.type === "session_read" && event.sessionId === sessionId,
    { from: mark }
  );
  expect(unreadIn(await watcher.listSessions(), sessionId)).toBeUndefined();
});

test("leaves a turn unread when the tab attached to it is not looking", async () => {
  const hidden = await connect({ attentive: false });
  const sessionId = hidden.sessionId!;
  const mark = hidden.events.length;
  await prompt(hidden, "say hello", mark);
  await idle(hidden, mark);

  expect(unreadIn(await hidden.listSessions(), sessionId)).toBe(true);
});

test("keeps a hidden tab's session unread for the client working elsewhere", async () => {
  const hidden = await connect({ attentive: false });
  const sessionId = hidden.sessionId!;
  const watcher = await connect();
  expect(watcher.sessionId).not.toBe(sessionId);

  const mark = hidden.events.length;
  await prompt(hidden, "say hello", mark);
  await idle(hidden, mark);

  expect(unreadIn(await watcher.listSessions(), sessionId)).toBe(true);
  expect(unreadIn(await hidden.listSessions(), sessionId)).toBe(true);
});

test("reads nothing on a reconnect from a hidden tab, and reads it on the way back", async () => {
  const worker = await connect();
  const sessionId = worker.sessionId!;
  const first = worker.events.length;
  await prompt(worker, "say hello", first);
  await idle(worker, first);

  const watcher = await connect();
  const release = holdTurn();
  const mark = watcher.events.length;
  await worker.prompt("say hello again");
  await watcher.waitFor(
    (event) =>
      event.type === "session_activity" &&
      event.sessionId === sessionId &&
      event.status !== "idle",
    { from: mark }
  );
  worker.close();
  release();
  await watcher.waitFor(
    (event) =>
      event.type === "session_activity" &&
      event.sessionId === sessionId &&
      event.status === "idle",
    { from: mark }
  );
  expect(unreadIn(await watcher.listSessions(), sessionId)).toBe(true);

  // A reconnect from a hidden tab must not consume the mark.
  const hidden = await connect({ sessionId, fromSeq: 0, attentive: false });
  expect(hidden.sessionId).toBe(sessionId);
  expect(unreadIn(await watcher.listSessions(), sessionId)).toBe(true);

  await hidden.attention(true);
  await watcher.waitFor(
    (event) => event.type === "session_read" && event.sessionId === sessionId,
    { from: mark }
  );
  expect(unreadIn(await watcher.listSessions(), sessionId)).toBeUndefined();
});

test("streams the whole turn to a tab that is not looking", async () => {
  Bun.spawnSync(["git", "init", "-q", "-b", "trunk"], { cwd: tmp });

  const hidden = await connect({ attentive: false });
  const mark = hidden.events.length;
  await prompt(hidden, "say hello", mark);
  await idle(hidden, mark);

  expect(hidden.events.some((event) => event.type === "text_delta")).toBe(true);
  const state = await hidden.waitFor(
    (event) => event.type === "session_state" && event.branch !== undefined
  );
  expect(state.type === "session_state" && state.branch).toBe("trunk");
});

test("starts with nothing unread, and keeps what is across a restart", async () => {
  // A fresh install starts with everything older read.
  const before = "00000000-0000-4000-8000-00000000old1";
  const after = "00000000-0000-4000-8000-00000000new1";
  await writeSession(before, SessionFixture.minutesAgo(30));
  await writeSession(after, new Date(Date.now() + 60_000).toISOString());

  const probe = await connect();
  const listed = await probe.listSessions();
  expect(unreadIn(listed, before)).toBeUndefined();
  expect(unreadIn(listed, after)).toBe(true);
  probe.close();

  await gateway.stop();
  await registry.disposeAll();
  await startGateway();

  // The baseline is persisted, not taken from the clock on each start.
  const restarted = await connect();
  const again = await restarted.listSessions();
  expect(unreadIn(again, before)).toBeUndefined();
  expect(unreadIn(again, after)).toBe(true);
});

test("orders the catalogue by the last reply, not by the last keystroke", async () => {
  // mtimes are reversed: `stale` was typed into recently but answered an hour ago.
  const fresh = "00000000-0000-4000-8000-0000000fresh";
  const stale = "00000000-0000-4000-8000-0000000stale";
  const answered = SessionFixture.minutesAgo(60);
  await writeSession(fresh, SessionFixture.minutesAgo(1));
  await writeSession(stale, answered, SessionFixture.minutesAgo(0));

  const probe = await connect();
  const listed = await probe.listSessions();
  const written = listed.filter((row) => row.sessionId.startsWith("00000000"));

  expect(written.map((row) => row.sessionId)).toEqual([fresh, stale]);
  // Dated by the reply, not the pending message.
  expect(written[1]!.settledAt).toBe(Date.parse(answered));
});

test("survives a restart with sessions resumable from disk", async () => {
  const probe = await connect();
  const sessionId = probe.sessionId!;
  const mark = probe.events.length;
  await prompt(probe, "say hello", mark);
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
  await prompt(probe, "say hello", mark);
  await idle(probe, mark);

  const listed = await probe.listSessions();
  expect(listed.map((row) => row.sessionId)).toContain(sessionId);
  const mine = listed.find((row) => row.sessionId === sessionId)!;
  expect(mine.cwd).toBe(tmp);
  expect(mine.settledAt).toBeGreaterThan(0);
  expect(mine.title).toBe("say hello");
  expect(Object.keys(mine).sort()).toEqual([
    "createdAt",
    "cwd",
    "sessionId",
    "settledAt",
    "title",
  ]);

  expect(await probe.listSessions({ cwd: "/nowhere" })).toEqual([]);

  // The one command that answers without an attach.
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
  const state = probe.events.findLast(
    (event) => event.type === "session_state"
  );
  expect(state?.type === "session_state" && state.modelLabel).toBe("echo");
  // Thinking levels need an attached session.
  expect(thinkingLevels).toBeArray();
});

test("session state carries context usage and the cwd's git branch", async () => {
  Bun.spawnSync(["git", "init", "-q", "-b", "trunk"], { cwd: tmp });

  const probe = await connect();
  const mark = probe.events.length;
  await prompt(probe, "say hello", mark);
  await idle(probe, mark);

  // Git is read async, so the branch lands on a later state.
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

test("a command this server does not know is refused without dropping the client", async () => {
  const probe = new ProbeClient({ url: gateway.url, cwd: tmp });
  probes.push(probe);
  const attached = await probe.connect();
  expect(attached.success).toBe(true);

  const response = await probe.send({
    type: "invented_by_a_newer_client",
  } as unknown as CommandDraft);
  expect(response.success).toBe(false);
  expect(response.error).toContain("unknown command");

  const after = await probe.send({ type: "attention", value: true });
  expect(after.success).toBe(true);
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

  await until(
    () => saidBy(probe).length === 2,
    "the queued message to be delivered"
  );
  expect(saidBy(probe)).toEqual(["say hello", "steer me\n\nand then this"]);
});

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
  // A queued message from a killed turn goes back to the client, not the log.
  expect(saidBy(probe)).toEqual(["say hello"]);
});

test("taking the queued message back leaves the turn running", async () => {
  const { probe, mark, response } = await reclaim("dequeue");

  expect(response.success).toBe(true);
  expect(response.restored).toEqual(["steer me"]);
  await idle(probe, mark);
  expect(saidBy(probe)).toEqual(["say hello"]);
});

test("a working agent freezes the repository its session sits in", async () => {
  await makeRepo(tmp, ["feat/work"]);
  const probe = await connect();
  const sessionId = probe.sessionId!;
  const mark = probe.events.length;
  const release = holdTurn();
  try {
    await probe.prompt("say hello");
    await probe.waitFor(
      (event) => event.type === "session_state" && event.repoBusy === true,
      { from: mark }
    );

    const refused = await probe.send({
      type: "checkout",
      sessionId,
      branch: "feat/work",
    });

    expect(refused.success).toBe(false);
    expect(refused.error).toContain("working");
  } finally {
    release();
  }
  await idle(probe, mark);

  const moved = await probe.send({
    type: "checkout",
    sessionId,
    branch: "feat/work",
  });
  // Check the error first so a git failure is distinguishable.
  expect(moved.error).toBeUndefined();
  expect(moved.success).toBe(true);
});

test("keeps a renamed row named through the turn that is writing to it", async () => {
  const probe = await connect();
  const sessionId = probe.sessionId!;
  const mark = probe.events.length;
  await prompt(probe, "say hello", mark);
  await idle(probe, mark);

  // Warm the digest while it still uses the opening message.
  expect(
    SessionFixture.rowIn(await probe.listSessions(), sessionId)?.title
  ).toBe("say hello");
  expect((await probe.rename(sessionId, "Parser work")).success).toBe(true);

  const release = holdTurn();
  const second = probe.events.length;
  try {
    await probe.prompt("say hello again");
    await probe.waitFor(
      (event) =>
        event.type === "session_activity" &&
        event.sessionId === sessionId &&
        event.status !== "idle",
      { from: second }
    );

    // Mid-turn the digest is reused, so the name must come from the live session.
    const row = SessionFixture.rowIn(await probe.listSessions(), sessionId);
    expect(row?.title).toBe("Parser work");
    expect(row?.named).toBe(true);
  } finally {
    release();
  }
  await idle(probe, second);
});
