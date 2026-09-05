import type { AssistantMessage } from "@earendil-works/pi-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { EventLog } from "./EventLog";

const FIXTURE = join(import.meta.dir, "fixtures", "pi-session-v3.jsonl");

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pim-event-log-test-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function copyFixture(name = "session.jsonl"): Promise<string> {
  const path = join(tmp, name);
  await Bun.write(path, Bun.file(FIXTURE));
  return path;
}

describe("EventLog replay", () => {
  test("reads a real pi session file, seq is the physical line ordinal", async () => {
    const log = new EventLog(FIXTURE);
    const entries = await log.read();

    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(entries.map((e) => e.entry.type)).toEqual([
      "session",
      "model_change",
      "thinking_level_change",
      "message",
      "message",
      "message",
      "message",
    ]);

    const header = await new EventLog(FIXTURE).header();
    expect(header?.id).toBe("019fbcd4-6fe8-78eb-914d-6a736b04203e");
    expect(header?.cwd).toBe("/home/htpc/Desktop/dev/mmorpg");
    expect(await new EventLog(FIXTURE).head()).toBe(7);
  });

  test("resuming at an arbitrary seq loses nothing", async () => {
    const whole = await new EventLog(FIXTURE).read();

    for (let cut = 0; cut <= whole.length; cut++) {
      const killed = new EventLog(FIXTURE);
      const before = await killed.read(0);
      const resumed = await new EventLog(FIXTURE).read(cut);

      expect([...before.slice(0, cut), ...resumed]).toEqual([...whole]);
    }
  });

  test("an interrupted read resumes exactly where it stopped", async () => {
    const path = await copyFixture();
    const log = new EventLog(path);

    const first = await log.read();
    expect(first).toHaveLength(7);
    expect(await log.read(7)).toEqual([]);

    const appended = `${JSON.stringify({
      type: "message",
      id: "deadbeef",
      parentId: "a6f46698",
      timestamp: "2026-08-01T10:18:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "again" }] },
    })}\n`;
    await Bun.file(path).write((await Bun.file(path).text()) + appended);

    const tail = await log.read(7);
    expect(tail.map((e) => e.seq)).toEqual([8]);
  });

  test("a torn final line is withheld until it is terminated", async () => {
    const path = join(tmp, "torn.jsonl");
    const full = await Bun.file(FIXTURE).text();
    const torn = full.slice(0, full.length - 40);
    await Bun.write(path, torn);

    const log = new EventLog(path);
    const partial = await log.read();
    expect(partial).toHaveLength(6);
    expect(await log.head()).toBe(6);

    await Bun.write(path, full);
    const rest = await log.read(6);
    expect(rest.map((e) => e.seq)).toEqual([7]);
  });

  test("an appended compaction does not shift earlier ordinals", async () => {
    const path = await copyFixture();
    const log = new EventLog(path);
    const before = await log.read();

    const compaction = `${JSON.stringify({
      type: "compaction",
      id: "c0ffee01",
      parentId: "a6f46698",
      timestamp: "2026-08-01T10:19:00.000Z",
      summary: "summarised",
      firstKeptEntryId: "a6f46698",
      tokensBefore: 4185,
    })}\n`;
    await Bun.file(path).write((await Bun.file(path).text()) + compaction);

    const after = await new EventLog(path).read();
    expect(after.slice(0, before.length)).toEqual([...before]);
    expect(after.at(-1)?.seq).toBe(8);
    expect(after.at(-1)?.entry.type).toBe("compaction");
  });

  test("a session that pi has not flushed yet reads as empty", async () => {
    const log = new EventLog(join(tmp, "never-written.jsonl"));
    expect(await log.read()).toEqual([]);
    expect(await log.head()).toBe(0);
  });
});

describe("EventLog digest", () => {
  test("names a session by its first user message and counts its lines", async () => {
    const digest = await new EventLog(FIXTURE).digest();

    expect(digest.title).toBe(
      "Use the subagent tool with the prompt 'reply with exactly PONG'. Then tell me the subagent's output."
    );
    expect(digest.head).toBe(7);
  });

  test("trims a long opening message rather than widening the sidebar", async () => {
    const path = join(tmp, "long.jsonl");
    const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;
    await Bun.write(
      path,
      line({
        type: "session",
        id: "s1",
        timestamp: "2026-08-01T10:00:00.000Z",
        cwd: "/tmp",
      }) +
        line({
          type: "message",
          id: "m1",
          parentId: null,
          timestamp: "2026-08-01T10:00:01.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "x".repeat(500) }],
          },
        })
    );

    const digest = await new EventLog(path).digest();
    expect(digest.title).toBe(`${"x".repeat(120)}…`);
    expect(digest.head).toBe(2);
  });

  test("a session with no user message yet has no name and no lines", async () => {
    const digest = await new EventLog(join(tmp, "absent.jsonl")).digest();

    expect(digest.title).toBeUndefined();
    expect(digest.head).toBe(0);
  });
});

describe("EventLog in-flight turn", () => {
  const assistant = (text: string, thinking = ""): AssistantMessage => ({
    role: "assistant",
    content: [
      ...(thinking
        ? [{ type: "thinking" as const, thinking, thinkingSignature: "" }]
        : []),
      { type: "text" as const, text },
    ],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "m",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      reasoning: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  });

  test("coalesces streaming deltas into one replayable block", () => {
    const log = new EventLog(FIXTURE);
    expect(log.inFlight).toBeUndefined();

    log.observe({ type: "agent_start" });
    log.observe({
      type: "message_update",
      message: assistant("Hel"),
      assistantMessageEvent: { type: "text_delta" } as never,
    });
    log.observe({
      type: "message_update",
      message: assistant("Hello there", "hmm"),
      assistantMessageEvent: { type: "text_delta" } as never,
    });

    expect(log.inFlight?.text).toBe("Hello there");
    expect(log.inFlight?.thinking).toBe("hmm");
  });

  test("tracks running tools and clears once the agent settles", () => {
    const log = new EventLog(FIXTURE);
    log.observe({ type: "agent_start" });
    log.observe({
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "read",
      args: {},
    });
    expect(log.inFlight?.tools.map((t) => t.toolName)).toEqual(["read"]);

    log.observe({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "read",
      result: {},
      isError: false,
    });
    expect(log.inFlight?.tools).toEqual([]);

    log.observe({ type: "agent_settled" });
    expect(log.inFlight).toBeUndefined();
  });
});
