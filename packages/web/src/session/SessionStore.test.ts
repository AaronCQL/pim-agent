import "../test/dom";

import { describe, expect, test } from "bun:test";
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

    expect(target.state.liveText).toBe("Hello");
    expect(toRows(target.timeline(), target.streamingId())).toEqual([
      {
        kind: "message",
        id: "live-1",
        role: "assistant",
        text: "Hello",
        // The live turn has not been written yet, so its stamp is this
        // client's clock until the durable message supersedes it.
        timestamp: expect.any(Number),
        streaming: true,
      },
    ]);

    feed(target, {
      seq: 7,
      type: "message",
      messageId: "m1",
      role: "assistant",
      text: "Hello",
      timestamp: 0,
    });

    expect(target.state.liveText).toBe("");
    expect(toRows(target.timeline()).map((row) => row.id)).toEqual(["m1"]);
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
      { type: "tool_call", callId: "c1", name: "shell", view: VIEW },
      {
        type: "tool_update",
        callId: "c1",
        view: { ...VIEW, summary: [{ kind: "text", text: "running" }] },
      }
    );

    const streaming = toRows(target.timeline());
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

    expect(target.state.liveTools).toEqual([]);
    const settled = toRows(target.timeline());
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
    expect(target.state.liveText).toBe("");
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
    const echoed = toRows(target.timeline());
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
    expect(toRows(target.timeline())).toHaveLength(1);
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
    dirty: true,
  });

  expect(target.state.agent).toBe("streaming");
  expect(target.state.model).toBe("sonnet");
  expect(target.state.tps).toBe(42);
  expect(target.state.contextPercent).toBe(20.2);
  expect(target.state.contextWindow).toBe(1_000_000);
  expect(target.state.branch).toBe("trunk");
  expect(target.state.dirty).toBe(true);
  expect(target.isBusy()).toBe(true);
});

describe("the read cursor", () => {
  test("attaching reads to the head, and every durable event past it", () => {
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

    // It is this browser's cursor, so a reload finds it where it was left.
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
