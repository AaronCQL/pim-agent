import type { AssistantMessage } from "@earendil-works/pi-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { EventLog } from "./EventLog";

const FIXTURE = join(import.meta.dir, "fixtures", "pi-session-v3.jsonl");

const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;

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
  test("names a session by its first user message", async () => {
    const digest = await new EventLog(FIXTURE).digest();

    expect(digest.title).toBe(
      "Use the subagent tool with the prompt 'reply with exactly PONG'. Then tell me the subagent's output."
    );
  });

  test("trims a long opening message rather than widening the sidebar", async () => {
    const path = join(tmp, "long.jsonl");
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
  });

  test("a session with no user message yet has no name", async () => {
    const digest = await new EventLog(join(tmp, "absent.jsonl")).digest();

    expect(digest.title).toBeUndefined();
    expect(digest.settledAt).toBeUndefined();
  });

  test("names a session opened with an inline image by what was typed", async () => {
    // pi stores an attached image as base64 in the message, so line 4 of a
    // session that starts with a screenshot is hundreds of kilobytes wide.
    // The name is on that line, in the text part in front of the photo.
    const path = join(tmp, "photo.jsonl");
    await Bun.write(
      path,
      line({
        type: "session",
        id: "s1",
        timestamp: "2026-08-01T10:00:00.000Z",
        cwd: "/tmp",
      }) +
        line({
          type: "model_change",
          id: "m0",
          parentId: null,
          timestamp: "2026-08-01T10:00:00.500Z",
          provider: "anthropic",
          modelId: "claude-opus-5",
        }) +
        line({
          type: "message",
          id: "m1",
          parentId: "m0",
          timestamp: "2026-08-01T10:00:01.000Z",
          message: {
            role: "user",
            content: [
              { type: "text", text: "why is this row unnamed" },
              {
                type: "image",
                data: "A".repeat(450 * 1024),
                mimeType: "image/png",
              },
            ],
          },
        })
    );

    expect((await new EventLog(path).digest()).title).toBe(
      "why is this row unnamed"
    );
  });

  test("an opening message still being written is not a name", async () => {
    // Same shape, cut mid-entry: a fragment is not an entry, however much of
    // it is on disk. Naming a row from one would show half a message.
    const path = join(tmp, "torn-head.jsonl");
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
            content: [{ type: "text", text: "y".repeat(200 * 1024) }],
          },
        }).slice(0, -20_000)
    );

    const log = new EventLog(path);
    expect((await log.digest()).title).toBeUndefined();
    // The header is line 1 and complete, so it survives the same read.
    expect((await log.header())?.id).toBe("s1");
  });

  test("skips past the entries pi writes before the user speaks", async () => {
    const path = join(tmp, "preamble.jsonl");
    const preamble = Array.from({ length: 8 }, (_, n) =>
      line({
        type: "custom",
        id: `c${n}`,
        parentId: null,
        timestamp: "2026-08-01T10:00:00.000Z",
        customType: "some-extension",
        data: { n },
      })
    ).join("");
    await Bun.write(
      path,
      line({
        type: "session",
        id: "s1",
        timestamp: "2026-08-01T10:00:00.000Z",
        cwd: "/tmp",
      }) +
        preamble +
        line({
          type: "message",
          id: "m1",
          parentId: null,
          timestamp: "2026-08-01T10:00:01.000Z",
          message: { role: "user", content: [{ type: "text", text: "hello" }] },
        })
    );

    expect((await new EventLog(path).digest()).title).toBe("hello");
  });
});

describe("EventLog settle time", () => {
  const at = (n: number) =>
    `2026-08-01T10:00:${String(n).padStart(2, "0")}.000Z`;
  const said = (n: number, message: unknown) =>
    line({
      type: "message",
      id: `m${n}`,
      parentId: null,
      timestamp: at(n),
      message,
    });
  const user = (n: number) =>
    said(n, { role: "user", content: [{ type: "text", text: "go on" }] });
  const assistant = (n: number, content: unknown[]) =>
    said(n, { role: "assistant", content });
  const result = (n: number) =>
    said(n, {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "ping",
      content: [{ type: "text", text: "pong" }],
    });

  async function write(...lines: string[]): Promise<EventLog> {
    // A fresh directory per test, so one name serves every case.
    const path = join(tmp, "settle.jsonl");
    await Bun.write(
      path,
      line({ type: "session", id: "s1", timestamp: at(0), cwd: "/tmp" }) +
        lines.join("")
    );
    return new EventLog(path);
  }

  test("dates the agent's last word, whatever the user said after it", async () => {
    const log = await write(
      user(1),
      assistant(2, [{ type: "text", text: "done" }]),
      // Queued while the agent was idle: three messages, no reply. None of
      // them is the agent having answered, so none of them is the date.
      user(3),
      user(4),
      user(5)
    );

    expect((await log.digest()).settledAt).toBe(Date.parse(at(2)));
  });

  test("a turn that stopped on a tool is dated by the tool", async () => {
    // No closing message: a tool that terminated the run, or an abort. The
    // agent stopped there all the same, and there is no line in pi's file
    // that says so — only the fact that nothing was written after it.
    const log = await write(
      user(1),
      assistant(2, [
        { type: "toolCall", id: "c1", name: "ping", arguments: {} },
      ]),
      result(3)
    );

    expect((await log.digest()).settledAt).toBe(Date.parse(at(3)));
  });

  test("an agent that has never answered has no settle time", async () => {
    const log = await write(user(1));

    expect((await log.digest()).settledAt).toBeUndefined();
  });

  test("a final line with no newline yet is a write in progress, not a date", async () => {
    // pi flushes the entry and its terminator separately, so a whole valid
    // entry can be on disk before it is durable. Dating a session by one
    // would move a row — and raise its dot — mid-write.
    const log = await write(
      user(1),
      assistant(2, [{ type: "text", text: "done" }]),
      assistant(3, [{ type: "text", text: "still typing" }]).trimEnd()
    );

    expect((await log.digest()).settledAt).toBe(Date.parse(at(2)));
  });

  test("reads back past a large final message rather than a fixed window", async () => {
    const log = await write(
      user(1),
      assistant(2, [{ type: "text", text: "x".repeat(512 * 1024) }]),
      user(3)
    );

    expect((await log.digest()).settledAt).toBe(Date.parse(at(2)));
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
