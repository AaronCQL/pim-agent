import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import type { SessionHost } from "#core/session/SessionHost";
import type { EphemeralEvent, ServerEvent } from "#protocol/ServerEvent";
import { SessionStream } from "./SessionStream";

let tmp: string;
let path: string;
let stream: SessionStream;
let seen: ServerEvent[];
let emit: (event: AgentSessionEvent) => void;

/**
 * A name this file owns. Tool views are registered process-wide by name, and
 * the suite is one process: a name another test file registers a view for
 * would paint these synthetic calls with that file's view, which reads a
 * `details` shape the events here have no reason to carry.
 */
const TOOL = "stream_probe";

/** Enough of a host for the stream to read a cwd and a status off. */
function host(): SessionHost {
  return {
    cwd: tmp,
    agentDir: tmp,
    usage: () => undefined,
    status: "thinking",
    settings: {},
    currentModelId: "test/echo",
    currentThinkingLevel: "off",
    tps: undefined,
  } as unknown as SessionHost;
}

/**
 * One event as pi would emit it. Cast whole rather than built: the test cares
 * about which events arrive in which order, not about the fields of pi's own
 * types that the stream never reads.
 */
function agentEvent(event: Record<string, unknown>): AgentSessionEvent {
  return event as unknown as AgentSessionEvent;
}

function thinkingMessage(thinking: string): Record<string, unknown> {
  return { role: "assistant", content: [{ type: "thinking", thinking }] };
}

/** Appends the line pi would have written, so the next drain finds it. */
async function persist(
  id: string,
  message: Record<string, unknown>
): Promise<void> {
  const entry = {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message,
  };
  await Bun.write(
    path,
    `${await Bun.file(path).text()}${JSON.stringify(entry)}\n`
  );
}

async function persistAssistant(
  id: string,
  content: readonly Record<string, unknown>[]
): Promise<void> {
  await persist(id, { role: "assistant", content });
}

async function persistToolResult(callId: string): Promise<void> {
  await persist(`r-${callId}`, {
    role: "toolResult",
    toolCallId: callId,
    toolName: TOOL,
    content: [],
    isError: false,
  });
}

/** One whole step: it streams, pi writes it down, then pi closes it. */
async function step(thinking: string, id: string): Promise<void> {
  emit(agentEvent({ type: "message_start", message: thinkingMessage("") }));
  emit(
    agentEvent({
      type: "message_update",
      message: thinkingMessage(thinking),
      assistantMessageEvent: {},
    })
  );
  await persistAssistant(id, [{ type: "thinking", thinking }]);
  emit(agentEvent({ type: "message_end", message: thinkingMessage(thinking) }));
  // The flush `message_end` started is not awaited, so wait for its result
  // rather than for a length of time.
  await stream.refresh();
  await until(() => durableThinking().includes(thinking), `the entry ${id}`);
}

async function until(ready: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await Bun.sleep(1);
  }
}

/**
 * What a client is handed, one event at a time: a drain of the log reaches it
 * as a single frame carrying several, and every reader here cares about the
 * events rather than about how they were packed.
 */
function received(): readonly ServerEvent[] {
  return seen.flatMap((event): readonly ServerEvent[] =>
    event.type === "replay" ? event.events : [event]
  );
}

/** The live messages that still stand, as a client would track them. */
function liveIds(): ReadonlySet<string> {
  const live = new Set<string>();
  for (const event of received()) {
    if (event.type === "message_start") {
      live.add(event.messageId);
    }
    if (event.type === "message_retire") {
      live.delete(event.messageId);
    }
  }
  return live;
}

/** What is still being drawn as live, and what the log says, separately. */
function liveThinking(): readonly string[] {
  const standing = liveIds();
  const thinking = new Map<string, string>();
  for (const event of received()) {
    if (event.type === "thinking_delta" && standing.has(event.messageId)) {
      thinking.set(
        event.messageId,
        `${thinking.get(event.messageId) ?? ""}${event.delta}`
      );
    }
  }
  return [...thinking.values()];
}

function durableThinking(): readonly string[] {
  return received().flatMap((event) =>
    event.type === "message" && event.role === "assistant" && event.thinking
      ? [event.thinking]
      : []
  );
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pim-stream-test-"));
  path = join(tmp, "session.jsonl");
  await Bun.write(
    path,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "s1",
      timestamp: new Date().toISOString(),
      cwd: tmp,
    })}\n`
  );
  stream = new SessionStream("s1", host(), path);
  seen = [];
  stream.subscribe((event) => {
    seen.push(event);
  });
  stream.start({
    subscribe: (listener: (event: AgentSessionEvent) => void) => {
      emit = listener;
      return () => {};
    },
  } as unknown as AgentSession);
  emit(agentEvent({ type: "agent_start" }));
});

afterEach(async () => {
  stream.dispose();
  await rm(tmp, { recursive: true, force: true });
});

/**
 * The interleaving that made a step paint twice: pi closes a message, writes
 * its entry, and only *then* runs the calls that message asked for. Those
 * calls open a live message of their own — there is nowhere else to hang them
 * — so by the time the next step's entry lands, the oldest live message is
 * that shell and not the step the entry belongs to. Retiring by position
 * there drops the shell and leaves the reasoning that streamed standing
 * underneath its own durable copy.
 */
test("retires the step an entry belongs to, not the oldest live message", async () => {
  await step("step one", "a1");

  // The call runs after the message that asked for it has been written.
  emit(
    agentEvent({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: TOOL,
      args: {},
    })
  );
  emit(
    agentEvent({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: TOOL,
      result: { content: [] },
      isError: false,
    })
  );

  await step("step two", "a2");

  expect(durableThinking()).toEqual(["step one", "step two"]);
  // Nothing the log now holds is still being drawn as live.
  expect(liveThinking()).toEqual([]);
});

/**
 * The two events are one swap, and a client that saw either half alone would
 * paint the step it names twice — once durable and once live — for as long as
 * it took the other half to arrive.
 */
test("sends a written step and the retire that supersedes it as one frame", async () => {
  await step("step one", "a1");

  const frame = seen.find(
    (event) =>
      event.type === "replay" &&
      event.events.some((inner) => inner.type === "message")
  );
  expect(frame?.type === "replay" && frame.events.map((e) => e.type)).toEqual([
    "message",
    "message_retire",
  ]);
});

/**
 * Pi closes a message before it runs the calls that message asked for, so a
 * call can outlive the entry of the step that made it. The stream holds it
 * anyway: until pi writes the result down, nothing else knows what that call
 * did, and a client that reattaches in between would be handed it spinning.
 */
test("keeps a retired step's calls, and drops each on its durable result", async () => {
  emit(agentEvent({ type: "message_start", message: thinkingMessage("") }));
  emit(
    agentEvent({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: TOOL,
      args: {},
    })
  );
  await persistAssistant("a1", [
    { type: "toolCall", id: "call_1", name: TOOL, arguments: {} },
  ]);
  emit(agentEvent({ type: "message_end", message: thinkingMessage("") }));
  await until(
    () => received().some((event) => event.type === "message_retire"),
    "the entry of the step that asked for the call"
  );

  emit(
    agentEvent({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: TOOL,
      result: { content: [] },
      isError: false,
    })
  );
  // Settled, and still the stream's to report: `fromSeq` past the log leaves
  // the in-flight turn alone as the answer.
  const running = await stream.replay(99);
  expect(running.filter((event) => event.type === "tool_end")).toHaveLength(1);

  await persistToolResult("call_1");
  emit(agentEvent({ type: "entry_appended" }));
  await until(
    () => received().some((event) => event.type === "tool_result"),
    "the result to be read out of the log"
  );

  // The log answers for the call now, so the live copy would only be a second
  // sighting of a row the client already has.
  const settled = await stream.replay(99);
  expect(settled.filter((event) => event.type === "tool_call")).toEqual([]);
});

test("hands a reattaching client each step exactly once", async () => {
  await step("step one", "a1");
  emit(agentEvent({ type: "message_start", message: thinkingMessage("") }));
  emit(
    agentEvent({
      type: "message_update",
      message: thinkingMessage("step two"),
      assistantMessageEvent: {},
    })
  );

  const thinking = (await stream.replay(0)).flatMap((event) => {
    if (event.type === "message" && event.role === "assistant") {
      return event.thinking ? [event.thinking] : [];
    }
    return event.type === "thinking_delta" ? [event.delta] : [];
  });
  expect(thinking).toEqual(["step one", "step two"]);
});

/**
 * A client that arrives mid-turn has no way of its own to know when that turn
 * began — the log's stamps are of the entries pi has finished writing, not of
 * the run — and only the process running it does. So the state carries the
 * age of the turn, and carries it as a duration: the two clocks need not
 * agree, and a duration does not ask them to.
 */
test("the state carries the age of the turn, and only while one is running", () => {
  let status: SessionHost["status"] = "thinking";
  const running = new SessionStream(
    "s2",
    {
      ...host(),
      get status() {
        return status;
      },
    } as unknown as SessionHost,
    path
  );
  let start!: (event: AgentSessionEvent) => void;
  running.start({
    subscribe: (listener: (event: AgentSessionEvent) => void) => {
      start = listener;
      return () => {};
    },
  } as unknown as AgentSession);

  const real = Date.now;
  let now = real();
  Date.now = () => now;
  try {
    start(agentEvent({ type: "agent_start" }));
    now += 45_000;
    expect(stateOf(running).turnElapsedMs).toBe(45_000);

    // Settled: there is no turn to be aged, and a stale reading would be
    // read as one still running.
    status = "idle";
    expect(stateOf(running).turnElapsedMs).toBeUndefined();
  } finally {
    Date.now = real;
    running.dispose();
  }
});

function stateOf(
  stream: SessionStream
): Extract<EphemeralEvent, { type: "session_state" }> {
  const event = stream.sessionState();
  if (event.type !== "session_state") {
    throw new Error(`expected session_state, got ${event.type}`);
  }
  return event;
}
