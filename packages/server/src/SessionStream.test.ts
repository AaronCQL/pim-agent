import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import type { SessionHost } from "#core/session/SessionHost";
import type { ServerEvent } from "#protocol/ServerEvent";
import { SessionStream } from "./SessionStream";

let tmp: string;
let path: string;
let stream: SessionStream;
let seen: ServerEvent[];
let emit: (event: AgentSessionEvent) => void;

/** Enough of a host for the stream to read a cwd and a status off. */
function host(): SessionHost {
  return {
    cwd: tmp,
    agentDir: tmp,
    agentSession: undefined,
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
async function persistAssistant(
  id: string,
  content: readonly Record<string, unknown>[]
): Promise<void> {
  const entry = {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "assistant", content },
  };
  await Bun.write(
    path,
    `${await Bun.file(path).text()}${JSON.stringify(entry)}\n`
  );
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

/** The live messages that still stand, as a client would track them. */
function liveIds(): ReadonlySet<string> {
  const live = new Set<string>();
  for (const event of seen) {
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
  for (const event of seen) {
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
  return seen.flatMap((event) =>
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
      toolName: "ping",
      args: {},
    })
  );
  emit(
    agentEvent({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "ping",
      result: { content: [] },
      isError: false,
    })
  );

  await step("step two", "a2");

  expect(durableThinking()).toEqual(["step one", "step two"]);
  // Nothing the log now holds is still being drawn as live.
  expect(liveThinking()).toEqual([]);
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
