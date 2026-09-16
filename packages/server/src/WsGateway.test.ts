import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Type } from "typebox";

import { makeRepo } from "#core/shared/fixtures/repo";
import type { CommandDraft } from "#protocol/Command";
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

/**
 * Set by a test to hold the prose turn open until it says otherwise, and
 * cleared by `afterEach` as well as by `release`. Both, because a test that
 * fails between `holdTurn()` and its `release()` never reaches the release —
 * and a gate left standing is awaited by the *next* test's model server,
 * whose turn then never ends and whose every wait burns its full timeout. One
 * failing assertion would otherwise cost the rest of the file 20s apiece.
 */
let gate: Promise<void> | undefined;
let openGate: (() => void) | undefined;

/**
 * Set by a test to make the provider refuse every call, the way a rate limit
 * or a dead key does. Not on the retryable list, so pi answers with the dead
 * turn immediately rather than backing off three times first.
 */
let refusal: string | undefined;

function holdTurn(): () => void {
  let release!: () => void;
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  openGate = release;
  return releaseTurn;
}

/** Idempotent, so `afterEach` and a test's own `finally` can both call it. */
function releaseTurn(): void {
  gate = undefined;
  openGate?.();
  openGate = undefined;
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
    // Pi's ToolDefinition is invariant in its schema, so a concrete one needs a
    // cast to sit in the erased array pi asks for.
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
 * The end of this probe's turn — not merely an event that says "idle".
 *
 * A `session_state` is pushed whenever anything the panel shows changes, and
 * the git watcher's first read pushes one of its own. That read is a handful
 * of subprocesses, so where it lands is a race: on this machine it arrives
 * before the caller's `from`, and on a slower one it arrives after `from` but
 * before the prompt has started work — carrying the status the session still
 * legitimately had, which is idle. Waiting on the event alone then hands the
 * test back mid-turn, and the turn-sensitive assertion after it fails for a
 * reason that has nothing to do with what it was testing.
 *
 * The host's own status is the truth the event is only a snapshot of, so an
 * idle event counts as the turn's end only when the host still agrees. When
 * it does not, the turn is running and its real end is yet to be pushed.
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
    // Stale, and so is everything buffered behind it while the host works:
    // only an event pushed from here on can be the end of this turn.
    cursor = probe.events.length;
  }
}

/**
 * Prompts, and returns once the turn it starts is running.
 *
 * `ProbeClient.prompt` resolves on the server's ack, which pi sends before it
 * has queued the turn: the session is still legitimately idle then, and so is
 * the state the git watcher's first read pushes a moment later. An `idle` taken
 * straight after therefore accepts the calm *before* the turn as its end, and
 * hands the test a session with no `message_start`, no delta and no reply —
 * the assertion after it fails for a reason that has nothing to do with what it
 * was testing.
 *
 * `agent_start` pushes a working state, so that is the edge worth waiting on,
 * and the event log is kept: a turn that has already begun and ended has that
 * state in it and this returns at once. Only for a prompt that starts a turn —
 * a message steered into a running one pushes no such state.
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

/** The mark one client is shown for one session; absent means read. */
function unreadIn(
  rows: readonly SessionSummaryView[],
  sessionId: string
): boolean | undefined {
  return rows.find((row) => row.sessionId === sessionId)?.unread;
}

function rowIn(
  rows: readonly SessionSummaryView[],
  sessionId: string
): SessionSummaryView | undefined {
  return rows.find((row) => row.sessionId === sessionId);
}

/** A whole-second ISO timestamp `n` minutes before now. */
function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString();
}

/**
 * Writes a session pi could have written, to say what a listing cannot be
 * made to say through the gateway: `repliedAt` is when the agent answered and
 * `saidAt`, when given, is a message typed in afterwards — which no prompt
 * can produce, because prompting runs a turn.
 */
async function writeSession(
  id: string,
  repliedAt: string,
  saidAt?: string
): Promise<void> {
  const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;
  const message = (at: string, message: unknown) =>
    line({ type: "message", id: at, parentId: null, timestamp: at, message });
  const path = join(agentDir, "sessions", "written", `${id}.jsonl`);
  await mkdir(join(agentDir, "sessions", "written"), { recursive: true });
  await Bun.write(
    path,
    line({ type: "session", version: 3, id, timestamp: repliedAt, cwd: tmp }) +
      message(repliedAt, {
        role: "user",
        content: [{ type: "text", text: "say hello" }],
      }) +
      message(repliedAt, {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      }) +
      (saidAt === undefined
        ? ""
        : message(saidAt, {
            role: "user",
            content: [{ type: "text", text: "and again" }],
          }))
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

/**
 * A provider that refuses ends the turn without a word of prose. Pi writes
 * the dead assistant message down like any other, so the client hears why
 * from the log — which is what makes it survive a reload, unlike a live
 * frame — rather than watching the agent stop for no stated reason. A rate
 * limit reads the same way; it is only refused here in words pi does not
 * retry, so the test costs no backoff.
 */
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

  // On the log and not only on the wire: a client attaching afterwards is
  // told the same thing by the replay.
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

/**
 * A turn is a model call per step, and pi writes the entry for a step long
 * after it streamed — here, not until the turn settles. So every step has to
 * be live in its own right: one `message_start` each, its own reasoning and
 * prose, and the calls it made hung off it.
 */
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
  // Only the step still streaming comes back live, announced once, and the
  // deltas — never persisted — arrive as the text so far. How many frames
  // that text is cut into is not asserted: the catch-up sends what had
  // accumulated by then, and a word streamed between that send and this line
  // is a second frame. Counting them was counting the scheduler.
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
        event.type !== "attached" &&
        // Server-wide, like the response and the handshake above it: which
        // of these a client has seen says when it arrived, not what the
        // session it is reading has done.
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
  // The reply landing on disk is the edge that cannot be missed: a queued turn
  // waiting on its lease is idle too, and so is one that has already finished.
  const settled = async (): Promise<boolean> => {
    const path = host.settings.sessionPath;
    if (path === undefined || host.status !== "idle" || host.isStreaming) {
      return false;
    }
    // Pi withholds the file itself until the first assistant message.
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
  // Once around, so pi has written the session and the catalogue can answer
  // for it: a client that arrives mid-turn reads the row, not the stream.
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

  // The user's message is on disk, so is the step that has already run, and
  // the file's modified time has moved twice — none of which is the agent
  // having finished. A row that climbed the list here would climb it again
  // on the next tool result.
  expect(settled(await watcher.listSessions())).toBe(before);

  release();
  await watcher.waitFor(
    (event) =>
      event.type === "session_activity" &&
      event.sessionId === sessionId &&
      event.status === "idle",
    { from: mark }
  );

  // And steps once, when the turn ends.
  expect(settled(await watcher.listSessions())).toBeGreaterThan(before);
});

test("goes unread when a turn ends, and not on the lines it ends with", async () => {
  const worker = await connect();
  const sessionId = worker.sessionId!;
  const first = worker.events.length;
  await prompt(worker, "say hello", first);
  await idle(worker, first);

  // Read, because a client has been sitting in it the whole turn — and the
  // answer is the same asked from a second browser, which is the point of
  // keeping the cursor here rather than in either of them.
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

  // Nobody is reading it and its first step is already written, result and
  // all. A turn is one thing to be told about, so none of that is news yet.
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

  // Opening it in one client reads it in all of them: the watcher is told
  // without having asked, because a mark it is holding has just gone stale.
  const reader = await connect({ sessionId, fromSeq: 0 });
  expect(reader.sessionId).toBe(sessionId);
  await watcher.waitFor(
    (event) => event.type === "session_read" && event.sessionId === sessionId,
    { from: mark }
  );
  expect(unreadIn(await watcher.listSessions(), sessionId)).toBeUndefined();
});

/**
 * A socket is not a reader. A backgrounded tab is attached to its session for
 * as long as the machine stays awake, and the turn it misses is exactly the
 * one it was left open to hear about.
 */
test("leaves a turn unread when the tab attached to it is not looking", async () => {
  const hidden = await connect({ attentive: false });
  const sessionId = hidden.sessionId!;
  const mark = hidden.events.length;
  await prompt(hidden, "say hello", mark);
  await idle(hidden, mark);

  expect(unreadIn(await hidden.listSessions(), sessionId)).toBe(true);
});

/**
 * The cursor is one machine's, so consuming it in the wrong tab is not a
 * mistake that stays there: the mark is broadcast, and the window the user is
 * actually in drops the dot it drew.
 */
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

  // A dropped socket comes back on its own, whether or not anyone is there to
  // see it: the mark a network blip would otherwise consume is still owed.
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

/**
 * Attention says who is owed the news, never who hears it. The watches follow
 * the attachment, so a hidden tab is still told everything — including the
 * branch, which only the git watch a dropped file watch takes with it can say.
 */
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
  // A fresh install opens on a quiet list rather than on a dot per
  // conversation its user has already had: everything older than this
  // server's first launch reads as read.
  const before = "00000000-0000-4000-8000-00000000old1";
  const after = "00000000-0000-4000-8000-00000000new1";
  await writeSession(before, minutesAgo(30));
  await writeSession(after, new Date(Date.now() + 60_000).toISOString());

  const probe = await connect();
  const listed = await probe.listSessions();
  expect(unreadIn(listed, before)).toBeUndefined();
  expect(unreadIn(listed, after)).toBe(true);
  probe.close();

  await gateway.stop();
  await registry.disposeAll();
  await startGateway();

  // The baseline is on disk rather than on the clock: taken from the clock,
  // every restart would read everything that had gone unread since the last.
  const restarted = await connect();
  const again = await restarted.listSessions();
  expect(unreadIn(again, before)).toBeUndefined();
  expect(unreadIn(again, after)).toBe(true);
});

test("orders the catalogue by the last reply, not by the last keystroke", async () => {
  // Written newest-file-last, so the modified times say the opposite of what
  // the conversations do: `stale` was typed into a moment ago and answered an
  // hour ago, `fresh` was answered a minute ago and left alone since.
  const fresh = "00000000-0000-4000-8000-0000000fresh";
  const stale = "00000000-0000-4000-8000-0000000stale";
  const answered = minutesAgo(60);
  await writeSession(fresh, minutesAgo(1));
  await writeSession(stale, answered, minutesAgo(0));

  const probe = await connect();
  const listed = await probe.listSessions();
  const written = listed.filter((row) => row.sessionId.startsWith("00000000"));

  expect(written.map((row) => row.sessionId)).toEqual([fresh, stale]);
  // Dated by the reply it has been waiting on an answer to since, not by the
  // message that is waiting.
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
  // Named by its opening message, and read: this client has been sitting in
  // it since before it answered.
  expect(mine.title).toBe("say hello");
  // The catalogue is pi's directory layout, not a store of ours.
  expect(Object.keys(mine).sort()).toEqual([
    "createdAt",
    "cwd",
    "sessionId",
    "settledAt",
    "title",
  ]);

  expect(await probe.listSessions({ cwd: "/nowhere" })).toEqual([]);

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
  await prompt(probe, "say hello", mark);
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

/**
 * There is no version handshake: client and server ship together, and the
 * only skew is a tab left open across a restart. So a client from another
 * build must degrade to the features both halves know, never to a dead
 * socket — the one command it asked for is refused, and it stays attached.
 */
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

  // Still a working client: the session it attached to still answers.
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

    // The model may be halfway through an edit; moving the tree under it would
    // land half its work on the wrong branch.
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
  // The error ahead of the flag: git's own failures are the only other way
  // this comes back false, and `false !== true` does not say which happened.
  expect(moved.error).toBeUndefined();
  expect(moved.success).toBe(true);
});

test("keeps a renamed row named through the turn that is writing to it", async () => {
  const probe = await connect();
  const sessionId = probe.sessionId!;
  const mark = probe.events.length;
  await prompt(probe, "say hello", mark);
  await idle(probe, mark);

  // Warms the digest the row is drawn from, while it still goes by its
  // opening message.
  expect(rowIn(await probe.listSessions(), sessionId)?.title).toBe("say hello");
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

    // Mid-turn the file is appended to between listings, so it is not
    // re-digested for any of them: the name the row shows is the live
    // session's own, and the one it was warmed with is a turn out of date.
    const row = rowIn(await probe.listSessions(), sessionId);
    expect(row?.title).toBe("Parser work");
    expect(row?.named).toBe(true);
  } finally {
    release();
  }
  await idle(probe, second);
});
