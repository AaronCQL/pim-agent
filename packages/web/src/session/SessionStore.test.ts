import "../test/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { flush } from "solid-js";

import { PROTOCOL_VERSION } from "#protocol/Protocol";
import type { ServerEvent } from "#protocol/ServerEvent";
import { toRows } from "../transcript/rows";
import { SessionStore } from "./SessionStore";

const VIEW = { title: [{ kind: "text" as const, text: "x" }] };

function store(): SessionStore {
  return new SessionStore({ url: "ws://127.0.0.1:1", pickerDebounceMs: 0 });
}

function feed(target: SessionStore, ...events: readonly ServerEvent[]): void {
  for (const event of events) {
    target.ingest(event);
  }
  flush();
}

/** Rows exactly as the transcript builds them: durable, echo, live, queued. */
function rows(target: SessionStore) {
  return toRows(target.state.durable, target.trailing(), target.state.live);
}

function attached(sessionId: string, head = 0): ServerEvent {
  return {
    type: "attached",
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    cwd: "/repo",
    head,
  };
}

describe("the in-flight bucket", () => {
  test("accumulates deltas and is superseded by the durable message", () => {
    const target = store();
    feed(
      target,
      attached("s1"),
      { type: "message_start", role: "assistant", messageId: "live-1" },
      { type: "text_delta", messageId: "live-1", delta: "Hel" },
      { type: "text_delta", messageId: "live-1", delta: "lo" }
    );

    expect(rows(target)).toEqual([
      {
        kind: "message",
        id: "live-1",
        role: "assistant",
        text: "Hello",
        // Never written, so never stamped; the durable message that
        // supersedes this one carries pi's own.
        timestamp: 0,
        streaming: true,
      },
    ]);

    feed(
      target,
      {
        seq: 7,
        type: "message",
        messageId: "m1",
        role: "assistant",
        text: "Hello",
        timestamp: 0,
      },
      { type: "message_retire", messageId: "live-1" }
    );

    expect(target.state.live).toEqual([]);
    expect(rows(target).map((row) => row.id)).toEqual(["m1"]);
  });

  /**
   * The bug this shape exists for: pi calls the model once per step and
   * appends the entries for every step at the end of the turn, so between the
   * first tool call and `idle` the only record of step one's prose is live.
   */
  test("keeps the prose of every step of a multi-step turn", () => {
    const target = store();
    feed(
      target,
      attached("s1"),
      { type: "message_start", role: "assistant", messageId: "live-1" },
      { type: "thinking_delta", messageId: "live-1", delta: "I should look." },
      { type: "text_delta", messageId: "live-1", delta: "Reading the file." },
      {
        type: "tool_call",
        callId: "c1",
        name: "read",
        messageId: "live-1",
        view: VIEW,
      },
      { type: "tool_end", callId: "c1", view: VIEW, isError: false },
      { type: "message_start", role: "assistant", messageId: "live-2" },
      { type: "text_delta", messageId: "live-2", delta: "It reads fine." }
    );

    expect(rows(target)).toMatchObject([
      {
        kind: "message",
        id: "live-1",
        text: "Reading the file.",
        thinking: "I should look.",
        streaming: true,
      },
      // Settled by `tool_end` long before pi writes the result down.
      { kind: "tool", id: "c1", isPartial: false },
      {
        kind: "message",
        id: "live-2",
        text: "It reads fine.",
        streaming: true,
      },
    ]);
  });

  test("the durable log retires the live message it names, and only that one", () => {
    const target = store();
    feed(
      target,
      attached("s1"),
      { type: "message_start", role: "assistant", messageId: "live-1" },
      { type: "text_delta", messageId: "live-1", delta: "one" },
      { type: "message_start", role: "assistant", messageId: "live-2" },
      { type: "text_delta", messageId: "live-2", delta: "two" },
      {
        seq: 5,
        type: "message",
        messageId: "m1",
        role: "assistant",
        text: "one",
        timestamp: 0,
      },
      { type: "message_retire", messageId: "live-1" }
    );

    // The step pi has written is durable; the one it has not is still live,
    // and neither is drawn twice.
    expect(rows(target).map((row) => row.id)).toEqual(["m1", "live-2"]);

    // Idle is only ever announced after the flush, so whatever is left has
    // been superseded.
    feed(target, {
      type: "session_state",
      cwd: "/repo",
      model: "sonnet",
      thinking: "off",
      cost: 0,
      status: "idle",
    });

    expect(target.state.live).toEqual([]);
  });

  /**
   * The server names the step it has written, because the two halves of the
   * turn are not in step: a step's calls stream after its message ends, so
   * the bucket can grow past the message whose entry has just landed.
   */
  test("retires by name, not by age, when the bucket has run ahead", () => {
    const target = store();
    feed(
      target,
      attached("s1"),
      { type: "message_start", role: "assistant", messageId: "live-1" },
      { type: "text_delta", messageId: "live-1", delta: "one" },
      {
        seq: 5,
        type: "message",
        messageId: "m1",
        role: "assistant",
        text: "one",
        timestamp: 0,
      },
      { type: "message_retire", messageId: "live-1" },
      // A shell for the call the written step asked for, then the next step.
      { type: "message_start", role: "assistant", messageId: "live-2" },
      { type: "message_start", role: "assistant", messageId: "live-3" },
      { type: "text_delta", messageId: "live-3", delta: "three" },
      {
        seq: 6,
        type: "message",
        messageId: "m2",
        role: "assistant",
        text: "three",
        timestamp: 0,
      },
      { type: "message_retire", messageId: "live-3" }
    );

    expect(rows(target).map((row) => row.id)).toEqual(["m1", "m2"]);
  });

  test("a live tool merges onto the durable call and the result wins", () => {
    const target = store();
    feed(
      target,
      attached("s1"),
      {
        seq: 4,
        type: "message",
        messageId: "m1",
        role: "assistant",
        text: "",
        timestamp: 0,
        toolCalls: [{ callId: "c1", name: "shell", view: VIEW }],
      },
      {
        type: "tool_call",
        callId: "c1",
        name: "shell",
        messageId: "live-1",
        view: VIEW,
      },
      {
        type: "tool_update",
        callId: "c1",
        view: { ...VIEW, summary: [{ kind: "text", text: "running" }] },
      }
    );

    const streaming = rows(target);
    expect(streaming).toHaveLength(1);
    expect(streaming[0]?.kind === "tool" && streaming[0].isPartial).toBe(true);
    expect(streaming[0]?.kind === "tool" && streaming[0].view.summary).toEqual([
      { kind: "text", text: "running" },
    ]);

    feed(target, {
      seq: 5,
      type: "tool_result",
      callId: "c1",
      name: "shell",
      view: { ...VIEW, summary: [{ kind: "text", text: "done" }] },
      isError: false,
    });

    expect(target.state.live.flatMap((message) => message.tools)).toEqual([]);
    const settled = rows(target);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.kind === "tool" && settled[0].isPartial).toBe(false);
  });

  test("re-attaching to the same session keeps the log and drops the bucket", () => {
    const target = store();
    feed(
      target,
      attached("s1"),
      { seq: 3, type: "notice", severity: "info", text: "hi" },
      { type: "text_delta", messageId: "live-1", delta: "partial" }
    );

    feed(target, attached("s1", 3));

    expect(target.state.durable).toHaveLength(1);
    expect(target.state.live).toEqual([]);
  });

  test("attaching to another session drops the log with it", () => {
    const target = store();
    feed(target, attached("s1"), {
      seq: 3,
      type: "notice",
      severity: "info",
      text: "hi",
    });

    feed(target, attached("s2"));

    expect(target.state.durable).toEqual([]);
    expect(target.state.sessionId).toBe("s2");
  });
});

describe("the optimistic echo", () => {
  test("is dropped by the durable user message that carries its text", () => {
    const target = store();
    feed(target, attached("s1"));
    void target.prompt("look at @src/x.ts");
    flush();

    expect(target.state.optimistic).toHaveLength(1);
    const echoed = rows(target);
    expect(echoed[0]?.kind === "message" && echoed[0].text).toBe(
      "look at @src/x.ts"
    );

    feed(target, {
      seq: 2,
      type: "message",
      messageId: "m1",
      role: "user",
      text: "look at @src/x.ts\n\n/srv/attachments/a.png",
      timestamp: 0,
    });

    expect(target.state.optimistic).toEqual([]);
    expect(rows(target)).toHaveLength(1);
  });

  test("one queued into a running turn waits below it", () => {
    const target = store();
    feed(
      target,
      attached("s1"),
      {
        type: "session_state",
        cwd: "/repo",
        model: "sonnet",
        thinking: "medium",
        cost: 0,
        status: "tool",
      },
      { type: "message_start", role: "assistant", messageId: "live-1" },
      { type: "text_delta", messageId: "live-1", delta: "working on it" }
    );
    void target.prompt("actually, use the other file");
    flush();

    // Under the prose still being written, not above it: the agent has not
    // heard this yet, so it cannot be drawn as the thing that came first.
    expect(
      rows(target).map((row) => (row.kind === "message" ? row.text : row.kind))
    ).toEqual(["working on it", "actually, use the other file"]);
  });

  test("a second message into the same turn joins the first, one card", () => {
    const target = store();
    feed(target, attached("s1"), {
      type: "session_state",
      cwd: "/repo",
      model: "sonnet",
      thinking: "medium",
      cost: 0,
      status: "tool",
    });
    void target.prompt("use the other file");
    void target.prompt("and mention the tide");
    flush();

    // Pi is holding one message, so the transcript shows one card and the
    // reader has one thing to click if they want it back.
    expect(target.state.optimistic).toHaveLength(1);
    expect(
      rows(target).map((row) => row.kind === "message" && row.text)
    ).toEqual(["use the other file\n\nand mention the tide"]);
  });
});

test("session_state lands on the fields the sidebar and composer paint", () => {
  const target = store();
  feed(target, attached("s1"), {
    type: "session_state",
    cwd: "/repo",
    model: "sonnet",
    thinking: "medium",
    cost: 0.5,
    status: "streaming",
    tps: 42,
    contextPercent: 20.2,
    contextWindow: 1_000_000,
    branch: "trunk",
    dirtyCount: 3,
    behind: 2,
  });

  expect(target.state.agent).toBe("streaming");
  expect(target.state.model).toBe("sonnet");
  expect(target.state.tps).toBe(42);
  expect(target.state.contextPercent).toBe(20.2);
  expect(target.state.contextWindow).toBe(1_000_000);
  expect(target.state.branch).toBe("trunk");
  expect(target.state.dirtyCount).toBe(3);
  expect(target.state.behind).toBe(2);
  expect(target.isBusy()).toBe(true);
});

describe("switching", () => {
  test("the session already on screen is not re-attached", async () => {
    const target = store();
    const asked: string[] = [];
    target.client.attachTo = async ({ sessionId }) => {
      asked.push(sessionId ?? "");
      return { type: "response", id: "1", success: true };
    };

    feed(target, attached("s1"));
    await target.switchTo("s1");
    // A second attach replays the log from the start, and this client keeps
    // what it has already painted: the transcript would read twice.
    expect(asked).toEqual([]);

    await target.switchTo("s2");
    expect(asked).toEqual(["s2"]);
  });

  test("the transcript is hidden from the click until the log has landed", async () => {
    const target = store();
    target.client.attachTo = async () => ({
      type: "response",
      id: "1",
      success: true,
    });

    feed(target, attached("s1"));
    await target.switchTo("s2");
    // Set before the server has answered, so the conversation being left is
    // not what fills the wait.
    expect(target.state.loading).toBe(true);

    feed(target, attached("s2", 9));
    expect(target.state.loading).toBe(true);

    feed(
      target,
      { seq: 9, type: "notice", severity: "info", text: "hi" },
      {
        type: "session_state",
        cwd: "/repo",
        model: "sonnet",
        thinking: "off",
        cost: 0,
        status: "idle",
      }
    );
    expect(target.state.loading).toBe(false);
  });

  test("a reconnect to the session on screen draws no curtain", () => {
    const target = store();
    feed(target, attached("s1", 4), {
      type: "session_state",
      cwd: "/repo",
      model: "sonnet",
      thinking: "off",
      cost: 0,
      status: "idle",
    });

    // The socket dropped and came back: the transcript is still on screen and
    // only its tail is missing, so there is nothing to hide.
    feed(target, attached("s1", 6));
    expect(target.state.loading).toBe(false);
  });
});

describe("the read cursor", () => {
  test("attaching reads to the head, and every durable event past it", async () => {
    localStorage.clear();
    const target = store();
    const summary = (head: number) => ({
      sessionId: "s1",
      cwd: "/repo",
      createdAt: 0,
      modifiedAt: 0,
      head,
    });

    feed(target, attached("s1", 4));
    expect(target.isUnread(summary(4))).toBe(false);
    expect(target.isUnread(summary(9))).toBe(true);

    feed(target, { seq: 9, type: "notice", severity: "info", text: "hi" });
    expect(target.isUnread(summary(9))).toBe(false);

    // It is this browser's cursor, so a reload finds it where it was left —
    // written once the batch that moved it has been applied, not per event.
    await Promise.resolve();
    expect(
      JSON.parse(localStorage.getItem("pim.seen") ?? "{}") as Record<
        string,
        number
      >
    ).toEqual({ s1: 9 });
  });

  test("a session this browser never opened is unread as soon as it has a line", () => {
    localStorage.clear();
    const target = store();

    expect(
      target.isUnread({
        sessionId: "other",
        cwd: "/repo",
        createdAt: 0,
        modifiedAt: 0,
        head: 1,
      })
    ).toBe(true);
  });
});

describe("drafts", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  /** An unwritten session belongs to the browser, so it is seeded there. */
  function held(sessionId: string, drafts: Record<string, string> = {}): void {
    localStorage.setItem(
      "pim.unwritten",
      JSON.stringify({ sessionId, cwd: "/repo", sent: false })
    );
    localStorage.setItem("pim.drafts", JSON.stringify(drafts));
  }

  test("one message per session, kept where it was typed", async () => {
    const target = store();
    feed(target, attached("s1"));
    target.setDraftText("half a thought");
    feed(target, attached("s2"));

    // The box is one box: what it holds is a property of the session
    // attached, so switching finds the other session's message and not this
    // one's.
    expect(target.draftText("s2")).toBe("");
    target.setDraftText("another one");
    flush();
    expect(target.draftText("s1")).toBe("half a thought");
    expect(target.draftText("s2")).toBe("another one");

    await Promise.resolve();
    // A reload is another store over the same storage.
    expect(store().draftText("s1")).toBe("half a thought");
  });

  test("an emptied box leaves nothing behind", async () => {
    const target = store();
    feed(target, attached("s1"));
    target.setDraftText("typed");
    target.setDraftText("");
    flush();

    expect(target.state.drafts).toEqual({});
    await Promise.resolve();
    expect(localStorage.getItem("pim.drafts")).toBe("{}");
  });

  test("a new chat is a row only once there is something in it", () => {
    held("d1");
    const target = store();
    feed(target, attached("d1"));

    // An empty composer is not a conversation: there is nothing to name the
    // row and nothing in it to come back to.
    expect(target.unwrittenSummary()).toBeUndefined();

    target.setDraftText("rework the sidebar");
    flush();
    expect(target.unwrittenSummary()).toEqual({
      sessionId: "d1",
      cwd: "/repo",
    });
    expect(target.localTitle("d1")).toBe("rework the sidebar");

    // And the row goes with the message that drew it.
    target.setDraftText("");
    flush();
    expect(target.unwrittenSummary()).toBeUndefined();
  });

  test("a sent message keeps the row the listing still cannot draw", async () => {
    held("d1");
    const target = store();
    target.client.send = async () => ({
      type: "response",
      id: "1",
      success: true,
    });
    feed(target, attached("d1"));
    target.setDraftText("say hello");
    flush();

    await target.prompt("say hello");
    flush();

    // Empty box, and a row named by what was sent rather than by what is
    // typed — pi has not written the log yet, so nothing else can draw one.
    expect(target.draftText("d1")).toBe("");
    expect(target.unwrittenSummary()).toEqual({
      sessionId: "d1",
      cwd: "/repo",
    });
    expect(target.localTitle("d1")).toBe("say hello");
  });

  test("the opening message outranks anything typed after it", async () => {
    held("d1");
    const target = store();
    target.client.send = async () => ({
      type: "response",
      id: "1",
      success: true,
    });
    feed(target, attached("d1"));

    await target.prompt("say hello");
    flush();
    // The next message being typed is not a rename: the session was named
    // the moment it was opened, and it keeps that name.
    target.setDraftText("and then say goodbye");
    flush();

    expect(target.localTitle("d1")).toBe("say hello");
  });

  test("the row stops being drawn once the directory can answer for it", async () => {
    held("d1", { d1: "typed" });
    const target = store();
    target.client.send = async () => ({
      type: "response",
      id: "1",
      success: true,
      sessions: [
        { sessionId: "d1", cwd: "/repo", createdAt: 0, modifiedAt: 5, head: 2 },
      ],
    });

    await target.listSessions();
    flush();

    expect(target.unwrittenSummary()).toBeUndefined();
    await Promise.resolve();
    expect(localStorage.getItem("pim.unwritten")).toBeNull();
    // The message typed into it is untouched: the session it belongs to is a
    // listed one now, and the box it is waiting in is the same box.
    expect(target.draftText("d1")).toBe("typed");
  });

  test("a session the gateway has forgotten is replaced, message and all", async () => {
    held("gone", { gone: "still typed" });
    const target = store();
    // An unwritten session has no file, so a gateway that restarted since
    // cannot resume it: the id is refused and the reload would otherwise
    // land nowhere.
    target.client.connect = async () => ({
      type: "response",
      id: "1",
      success: false,
      error: "no such session",
    });
    target.client.attachTo = async () => {
      target.ingest(attached("fresh"));
      return { type: "response", id: "2", success: true };
    };

    await target.connect();
    flush();

    expect(target.state.sessionId).toBe("fresh");
    expect(target.draftText("gone")).toBe("");
    expect(target.draftText("fresh")).toBe("still typed");
    expect(target.unwrittenSummary()).toEqual({
      sessionId: "fresh",
      cwd: "/repo",
    });
    expect(target.localTitle("fresh")).toBe("still typed");
  });
});
