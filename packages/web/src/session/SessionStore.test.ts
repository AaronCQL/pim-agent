import "../test/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { flush } from "solid-js";

import type { ToolView } from "#core/view/ViewBlock";
import type {
  ResponseEvent,
  SearchHitView,
  ServerEvent,
  SessionSummaryView,
} from "#protocol/ServerEvent";
import { toRows, type ToolRow } from "../transcript/rows";
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

function rows(target: SessionStore) {
  return toRows(target.state.durable, target.trailing(), target.state.live);
}

function painted(
  target: SessionStore,
  ...frames: readonly (readonly ServerEvent[])[]
): readonly (readonly string[])[] {
  return frames.map((frame) => {
    feed(target, ...frame);
    return rows(target).map((row) => row.id);
  });
}

function toolRow(target: SessionStore, callId: string): ToolRow | undefined {
  const row = rows(target).find((candidate) => candidate.id === callId);
  return row?.kind === "tool" ? row : undefined;
}

function attached(sessionId: string, head = 0): ServerEvent {
  return {
    type: "attached",
    sessionId,
    cwd: "/repo",
    head,
    pimVersion: "1.2.3",
    piVersion: "0.9.0",
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

  // Regression: pi writes every step's entries at turn end, so until then
  // earlier steps' prose exists only in live.
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

    expect(rows(target).map((row) => row.id)).toEqual(["m1", "live-2"]);

    feed(target, {
      type: "session_state",
      writable: true,
      cwd: "/repo",
      model: "sonnet",
      thinking: "off",
      cost: 0,
      status: "idle",
    });

    expect(target.state.live).toEqual([]);
  });

  // A step's calls stream after its message ends, so the bucket can run ahead of the log.
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

  // Pi writes the step before its call's result; in between, only the live
  // view is settled.
  test("a call settled live stays settled across the retire of its message", () => {
    const target = store();
    const settled = {
      ...VIEW,
      summary: [{ kind: "text" as const, text: "12 lines" }],
      body: [{ kind: "text" as const, text: "the output" }],
    };
    feed(
      target,
      attached("s1"),
      { type: "message_start", role: "assistant", messageId: "live-1" },
      { type: "text_delta", messageId: "live-1", delta: "Let me look." },
      {
        type: "tool_call",
        callId: "c1",
        name: "read",
        messageId: "live-1",
        view: VIEW,
      },
      { type: "tool_end", callId: "c1", view: settled, isError: false },
      {
        seq: 7,
        type: "message",
        messageId: "m1",
        role: "assistant",
        text: "Let me look.",
        timestamp: 0,
        toolCalls: [{ callId: "c1", name: "read", view: VIEW }],
      },
      { type: "message_retire", messageId: "live-1" }
    );

    expect(rows(target).map((row) => row.id)).toEqual(["m1", "c1"]);
    expect(toolRow(target, "c1")?.isPartial).toBe(false);
    expect(toolRow(target, "c1")?.view.summary).toEqual(settled.summary);
    expect(toolRow(target, "c1")?.view.body).toEqual(settled.body);

    feed(target, {
      seq: 8,
      type: "tool_result",
      callId: "c1",
      name: "read",
      view: settled,
      isError: false,
    });
    expect(target.state.live).toEqual([]);
    expect(rows(target).map((row) => row.id)).toEqual(["m1", "c1"]);
  });

  // The step, its retire and its result can land in one batch.
  test("a step written, retired and answered in one batch leaves nothing live", () => {
    const target = store();
    feed(
      target,
      attached("s1"),
      { type: "message_start", role: "assistant", messageId: "live-1" },
      { type: "text_delta", messageId: "live-1", delta: "Let me look." },
      {
        type: "tool_call",
        callId: "c1",
        name: "read",
        messageId: "live-1",
        view: VIEW,
      },
      { type: "tool_end", callId: "c1", view: VIEW, isError: false }
    );

    feed(
      target,
      {
        seq: 7,
        type: "message",
        messageId: "m1",
        role: "assistant",
        text: "Let me look.",
        timestamp: 0,
        toolCalls: [{ callId: "c1", name: "read", view: VIEW }],
      },
      { type: "message_retire", messageId: "live-1" },
      {
        seq: 8,
        type: "tool_result",
        callId: "c1",
        name: "read",
        view: VIEW,
        isError: false,
      }
    );

    expect(target.state.live).toEqual([]);
    expect(rows(target).map((row) => row.id)).toEqual(["m1", "c1"]);
  });

  // Pi closes a message before running its calls, so their updates can
  // arrive after the retire.
  test("a call still running when its message retires keeps streaming", () => {
    const target = store();
    feed(
      target,
      attached("s1"),
      { type: "message_start", role: "assistant", messageId: "live-1" },
      {
        type: "tool_call",
        callId: "c1",
        name: "bash",
        messageId: "live-1",
        view: VIEW,
      },
      {
        seq: 7,
        type: "message",
        messageId: "m1",
        role: "assistant",
        text: "",
        timestamp: 0,
        toolCalls: [{ callId: "c1", name: "bash", view: VIEW }],
      },
      { type: "message_retire", messageId: "live-1" },
      {
        type: "tool_update",
        callId: "c1",
        view: { ...VIEW, summary: [{ kind: "text", text: "running" }] },
      }
    );

    expect(toolRow(target, "c1")?.isPartial).toBe(true);
    expect(toolRow(target, "c1")?.view.summary).toEqual([
      { kind: "text", text: "running" },
    ]);

    feed(target, {
      type: "tool_end",
      callId: "c1",
      view: { ...VIEW, summary: [{ kind: "text", text: "done" }] },
      isError: false,
    });

    expect(toolRow(target, "c1")?.isPartial).toBe(false);
    expect(toolRow(target, "c1")?.view.summary).toEqual([
      { kind: "text", text: "done" },
    ]);
  });

  test("the retired shell draws nothing of its own and holds its calls in place", () => {
    const target = store();
    feed(
      target,
      attached("s1"),
      { type: "message_start", role: "assistant", messageId: "live-1" },
      { type: "text_delta", messageId: "live-1", delta: "one" },
      {
        type: "tool_call",
        callId: "c1",
        name: "read",
        messageId: "live-1",
        view: VIEW,
      },
      {
        seq: 7,
        type: "message",
        messageId: "m1",
        role: "assistant",
        text: "one",
        timestamp: 0,
        toolCalls: [{ callId: "c1", name: "read", view: VIEW }],
      },
      { type: "message_retire", messageId: "live-1" },
      { type: "message_start", role: "assistant", messageId: "live-2" },
      { type: "text_delta", messageId: "live-2", delta: "two" }
    );

    expect(rows(target).map((row) => row.id)).toEqual(["m1", "c1", "live-2"]);
  });

  // Drawing the step twice would make the scroll jump.
  test("the handoff to the log never paints a step twice", () => {
    const target = store();

    expect(
      painted(
        target,
        [attached("s1")],
        [{ type: "message_start", role: "assistant", messageId: "live-1" }],
        [{ type: "text_delta", messageId: "live-1", delta: "Let me look." }],
        [
          {
            seq: 7,
            type: "message",
            messageId: "m1",
            role: "assistant",
            text: "Let me look.",
            timestamp: 0,
          },
          { type: "message_retire", messageId: "live-1" },
        ]
      )
    ).toEqual([[], [], ["live-1"], ["m1"]]);
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
        writable: true,
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

    expect(
      rows(target).map((row) => (row.kind === "message" ? row.text : row.kind))
    ).toEqual(["working on it", "actually, use the other file"]);
  });

  test("a second message into the same turn joins the first, one card", () => {
    const target = store();
    feed(target, attached("s1"), {
      type: "session_state",
      writable: true,
      cwd: "/repo",
      model: "sonnet",
      thinking: "medium",
      cost: 0,
      status: "tool",
    });
    void target.prompt("use the other file");
    void target.prompt("and mention the tide");
    flush();

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
    writable: true,
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
    expect(target.state.loading).toBe(true);

    feed(target, attached("s2", 9));
    expect(target.state.loading).toBe(true);

    feed(
      target,
      { seq: 9, type: "notice", severity: "info", text: "hi" },
      {
        type: "session_state",
        writable: true,
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
      writable: true,
      cwd: "/repo",
      model: "sonnet",
      thinking: "off",
      cost: 0,
      status: "idle",
    });

    feed(target, attached("s1", 6));
    expect(target.state.loading).toBe(false);
  });
});

describe("unread", () => {
  test("is the server's answer, and any client reading a session clears it", async () => {
    const target = store();
    target.client.send = async () => ({
      type: "response",
      id: "1",
      success: true,
      sessions: [
        {
          sessionId: "s1",
          cwd: "/repo",
          createdAt: 0,
          settledAt: 5,
          unread: true,
        },
        { sessionId: "s2", cwd: "/repo", createdAt: 0, settledAt: 5 },
      ],
    });

    await target.listSessions();
    expect(target.isUnread("s1")).toBe(true);
    expect(target.isUnread("s2")).toBe(false);

    feed(target, { type: "session_read", sessionId: "s1" });
    expect(target.isUnread("s1")).toBe(false);
  });
});

describe("archive, names and pins", () => {
  type Sent = Record<string, unknown> & { readonly type: string };

  beforeEach(() => {
    localStorage.clear();
  });

  function row(
    sessionId: string,
    extra: Partial<SessionSummaryView> = {}
  ): SessionSummaryView {
    return { sessionId, cwd: "/repo", createdAt: 0, settledAt: 5, ...extra };
  }

  function wire(
    target: SessionStore,
    answer: { readonly success: boolean; readonly error?: string } = {
      success: true,
    }
  ): readonly Sent[] {
    const sent: Sent[] = [];
    target.client.send = (async (command: Sent) => {
      sent.push(command);
      return { type: "response", id: "1", ...answer };
    }) as typeof target.client.send;
    return sent;
  }

  function catalogue(
    target: SessionStore,
    sessions: readonly SessionSummaryView[]
  ): void {
    target.client.send = (async () => ({
      type: "response",
      id: "1",
      success: true,
      sessions,
    })) as typeof target.client.send;
  }

  test("every verb names its own row, not the session on screen", async () => {
    const target = store();
    const sent = wire(target);
    feed(target, attached("s1"));

    await target.rename("s2", "Refactor the parser");
    await target.setArchived("s3", true);
    await target.markUnread("s4", true);
    await target.setPinned("/repo", true);
    flush();

    expect(sent).toEqual([
      {
        type: "set_session_name",
        sessionId: "s2",
        value: "Refactor the parser",
      },
      { type: "set_session_archived", sessionId: "s3", value: true },
      { type: "set_session_unread", sessionId: "s4", value: true },
      { type: "set_project_pinned", cwd: "/repo", value: true },
    ]);
    expect(target.isArchived("s3")).toBe(true);
    expect(target.isUnread("s4")).toBe(true);
    expect(target.isPinned("/repo")).toBe(true);
  });

  test("a name is cleared with null, and comes back as one", async () => {
    const target = store();
    catalogue(target, [row("s1", { title: "Parser work", named: true })]);

    const { sessions: listed } = await target.listSessions();
    expect(listed[0]?.title).toBe("Parser work");
    expect(listed[0]?.named).toBe(true);
    expect(target.sessionName("s1")).toBe("Parser work");

    const sent = wire(target);
    await target.rename("s1", null);
    expect(sent).toEqual([
      { type: "set_session_name", sessionId: "s1", value: null },
    ]);
    feed(target, { type: "session_meta", sessionId: "s1", name: null });

    expect(target.sessionName("s1")).toBeUndefined();
    expect(target.state.names.s1).toBeNull();
  });

  test("a name is on the row before the server answers, and outlives a listing that raced it", async () => {
    const target = store();
    let answer: (() => void) | undefined;
    target.client.send = (async (command: Sent) => {
      if (command.type === "list_sessions") {
        return {
          type: "response",
          id: "1",
          success: true,
          sessions: [row("s1", { title: "Parser work", named: true })],
        };
      }
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
      return { type: "response", id: "2", success: true };
    }) as typeof target.client.send;

    const renaming = target.rename("s1", "Strings");
    flush();
    expect(target.sessionName("s1")).toBe("Strings");

    await target.listSessions();
    expect(target.sessionName("s1")).toBe("Strings");

    answer?.();
    await renaming;
  });

  test("a refused rename puts back the name the row had", async () => {
    const target = store();
    catalogue(target, [row("s1", { title: "Parser work", named: true })]);
    await target.listSessions();

    wire(target, { success: false, error: "read-only sidecar" });
    await expect(target.rename("s1", "Strings")).rejects.toThrow(
      "read-only sidecar"
    );
    flush();

    expect(target.sessionName("s1")).toBe("Parser work");
  });

  test("the refusal reaches the caller, and the guess is taken back", async () => {
    const target = store();
    wire(target, { success: false, error: "read-only sidecar" });

    await expect(target.setArchived("s1", true)).rejects.toThrow(
      "read-only sidecar"
    );
    await expect(target.markUnread("s1", true)).rejects.toThrow(
      "read-only sidecar"
    );
    await expect(target.setPinned("/repo", true)).rejects.toThrow(
      "read-only sidecar"
    );
    await expect(target.rename("s1", "Nope")).rejects.toThrow(
      "read-only sidecar"
    );
    flush();

    expect(target.isArchived("s1")).toBe(false);
    expect(target.isUnread("s1")).toBe(false);
    expect(target.isPinned("/repo")).toBe(false);
    expect(target.sessionName("s1")).toBeUndefined();
  });

  test("a broadcast patches a listing already in hand", async () => {
    const target = store();
    catalogue(target, [row("s1"), row("s2", { cwd: "/other" })]);
    const { sessions: held } = await target.listSessions();
    expect(held.map((one) => one.archived)).toEqual([undefined, undefined]);

    feed(
      target,
      {
        type: "session_meta",
        sessionId: "s1",
        archived: true,
        unread: true,
        name: "Parser work",
      },
      { type: "project_meta", cwd: "/other", pinned: true }
    );

    expect(target.isArchived("s1")).toBe(true);
    expect(target.isUnread("s1")).toBe(true);
    expect(target.sessionName("s1")).toBe("Parser work");
    expect(target.isPinned("/other")).toBe(true);
    expect(target.isPinned("/repo")).toBe(false);
    expect(target.isArchived("s2")).toBe(false);
  });

  test("a listing that raced the command does not paint the row back", async () => {
    const target = store();
    let answer: (() => void) | undefined;
    target.client.send = (async (command: Sent) => {
      if (command.type === "list_sessions") {
        return {
          type: "response",
          id: "1",
          success: true,
          sessions: [row("s1")],
        };
      }
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
      return { type: "response", id: "2", success: true };
    }) as typeof target.client.send;

    const archiving = target.setArchived("s1", true);
    await target.listSessions();

    expect(target.isArchived("s1")).toBe(true);
    answer?.();
    await archiving;
  });

  test("the archived listing is asked for by scope", async () => {
    const target = store();
    const sent = wire(target);

    await target.listSessions();
    await target.listSessions({ cwd: "/repo" });
    await target.listSessions({ archived: true });
    await target.listSessions({ perProject: 10 });

    expect(sent).toEqual([
      { type: "list_sessions" },
      { type: "list_sessions", cwd: "/repo" },
      { type: "list_sessions", archived: true },
      { type: "list_sessions", perProject: 10 },
    ]);
  });
});

describe("search", () => {
  const hit: SearchHitView = {
    sessionId: "s1",
    cwd: "/repo",
    title: "session-lease: refuse input mid-turn",
    titleRanges: [[8, 13]],
    settledAt: 5,
    snippets: [],
    total: 1,
  };

  type Sent = Record<string, unknown> & { readonly type: string };

  function wire(
    target: SessionStore,
    answer: Omit<ResponseEvent, "type" | "id">
  ): readonly Sent[] {
    const sent: Sent[] = [];
    target.client.send = (async (command: Sent) => {
      sent.push(command);
      return { type: "response" as const, id: "1", ...answer };
    }) as typeof target.client.send;
    return sent;
  }

  test("the query goes out with the scope it was given, and nothing else", async () => {
    const target = store();
    const sent = wire(target, { success: true, hits: [hit], scanned: 214 });

    const answer = await target.searchSessions("lease");
    await target.searchSessions("lease", {
      cwd: "/repo",
      archived: false,
      limit: 5,
    });

    expect(answer.hits).toEqual([hit]);
    expect(sent).toEqual([
      { type: "search_sessions", query: "lease" },
      {
        type: "search_sessions",
        query: "lease",
        cwd: "/repo",
        archived: false,
        limit: 5,
      },
    ]);
  });

  test("the warm call is the empty query, answering the scope it built over", async () => {
    const target = store();
    const sent = wire(target, { success: true, hits: [], scanned: 214 });

    const warm = await target.searchSessions("");

    expect(warm.hits).toEqual([]);
    expect(warm.scanned).toBe(214);
    expect(sent).toEqual([{ type: "search_sessions", query: "" }]);
  });

  test("a search nothing carried raises rather than answering a scope of nothing", async () => {
    const target = store();
    target.client.send = (async () => {
      throw new Error("the socket went away");
    }) as typeof target.client.send;

    await expect(target.searchSessions("lease")).rejects.toThrow(
      "the socket went away"
    );
  });

  test("a search the server refuses raises what it refused with", async () => {
    const target = store();
    wire(target, { success: false, error: "the index could not be read" });

    await expect(target.searchSessions("lease")).rejects.toThrow(
      "the index could not be read"
    );
  });

  test("a listing keeps its swallow: rows nobody sent are an empty page", async () => {
    const target = store();
    target.client.send = (async () => {
      throw new Error("the socket went away");
    }) as typeof target.client.send;

    expect(await target.listSessions()).toEqual({ sessions: [], projects: [] });
  });
});

describe("stored files", () => {
  const view: ToolView = {
    title: [{ kind: "file", path: "/tmp/revenue.png" }],
    summary: [
      {
        kind: "attachment",
        name: "revenue.png",
        url: "/attachment/s1/revenue-1.png",
        isImage: true,
      },
    ],
  };
  const url = "http://127.0.0.1:1/attachment/s1/revenue-1.png";

  test("a delivered file is fetchable by the time a painter sees it", () => {
    const target = store();
    feed(target, attached("s1"), {
      seq: 1,
      type: "tool_result",
      callId: "c1",
      name: "send_file",
      isError: false,
      view,
    });

    const block = toolRow(target, "c1")?.view.summary?.[0];
    expect(block).toEqual({
      kind: "attachment",
      name: "revenue.png",
      url,
      isImage: true,
    });
  });

  test("so is one carried on a message's own tool calls", () => {
    const target = store();
    feed(target, attached("s1"), {
      seq: 2,
      type: "message",
      messageId: "m1",
      role: "assistant",
      text: "there it is",
      timestamp: 1,
      toolCalls: [{ callId: "c1", name: "send_file", view }],
    });

    const durable = target.state.durable.at(-1);
    const carried =
      durable?.type === "message" ? durable.toolCalls?.[0]?.view : undefined;
    expect(carried?.summary?.[0]).toMatchObject({ url });
  });

  test("so is one nested in a body section", () => {
    const target = store();
    feed(target, attached("s1"), {
      seq: 3,
      type: "tool_result",
      callId: "c2",
      name: "send_file",
      isError: false,
      view: {
        title: [{ kind: "file", path: "docs/revenue.png" }],
        body: [
          {
            kind: "section",
            label: "revenue",
            content: [
              {
                kind: "attachment",
                name: "revenue.png",
                url: "/attachment/s1/revenue-1.png",
                isImage: true,
              },
            ],
          },
        ],
      },
    });

    const section = toolRow(target, "c2")?.view.body?.[0];
    expect(section?.kind === "section" && section.content[0]).toMatchObject({
      kind: "attachment",
      url,
    });
  });
});

describe("drafts", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

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

    expect(target.draftText("s2")).toBe("");
    target.setDraftText("another one");
    flush();
    expect(target.draftText("s1")).toBe("half a thought");
    expect(target.draftText("s2")).toBe("another one");

    await Promise.resolve();
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

    expect(target.unwrittenSummary()).toBeUndefined();

    target.setDraftText("rework the sidebar");
    flush();
    expect(target.unwrittenSummary()).toEqual({
      sessionId: "d1",
      cwd: "/repo",
    });
    expect(target.localTitle("d1")).toBe("rework the sidebar");

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
    target.setDraftText("and then say goodbye");
    flush();

    expect(target.localTitle("d1")).toBe("say hello");
  });

  test("the name survives leaving the session it belongs to", async () => {
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
    feed(target, attached("d2"));

    expect(target.localTitle("d1")).toBe("say hello");
  });

  test("the remembered name is dropped once the listing carries it", async () => {
    held("d1");
    const target = store();
    target.client.send = async () => ({
      type: "response",
      id: "1",
      success: true,
      sessions: [
        {
          sessionId: "d1",
          cwd: "/repo",
          createdAt: 0,
          settledAt: 5,
          title: "say hello",
        },
      ],
    });
    feed(target, attached("d1"));
    await target.prompt("say hello");
    flush();

    await target.listSessions();
    flush();

    expect(target.state.openings).toEqual({});
  });

  test("the row stops being drawn once the directory can answer for it", async () => {
    held("d1", { d1: "typed" });
    const target = store();
    target.client.send = async () => ({
      type: "response",
      id: "1",
      success: true,
      sessions: [{ sessionId: "d1", cwd: "/repo", createdAt: 0, settledAt: 5 }],
    });

    await target.listSessions();
    flush();

    expect(target.unwrittenSummary()).toBeUndefined();
    await Promise.resolve();
    expect(localStorage.getItem("pim.unwritten")).toBeNull();
    expect(target.draftText("d1")).toBe("typed");
  });

  test("a session the gateway has forgotten is replaced, message and all", async () => {
    held("gone", { gone: "still typed" });
    const target = store();
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

describe("the thinking cycle", () => {
  function levelled(
    target: SessionStore,
    levels: readonly string[]
  ): readonly string[] {
    const asked: string[] = [];
    target.client.send = (async (command: {
      readonly type: string;
      readonly value?: string;
    }) => {
      if (command.type === "set_thinking" && command.value !== undefined) {
        asked.push(command.value);
      }
      return {
        type: "response",
        id: "1",
        success: true,
        models: [],
        thinkingLevels: levels,
      };
    }) as typeof target.client.send;
    return asked;
  }

  function thinkingAt(target: SessionStore, level: string): void {
    feed(target, {
      type: "session_state",
      writable: true,
      cwd: "/repo",
      model: "sonnet",
      thinking: level,
      cost: 0,
      status: "idle",
    });
  }

  test("steps up the catalogue's order and wraps at the end", async () => {
    const target = store();
    const asked = levelled(target, ["off", "medium", "high"]);
    feed(target, attached("s1"));

    thinkingAt(target, "medium");
    await target.cycleThinking();
    thinkingAt(target, "high");
    await target.cycleThinking();

    expect(asked).toEqual(["high", "off"]);
  });

  test("a level the catalogue does not list starts at the top", async () => {
    const target = store();
    const asked = levelled(target, ["off", "medium"]);
    feed(target, attached("s1"));
    thinkingAt(target, "ultra");

    await target.cycleThinking();
    expect(asked).toEqual(["off"]);
  });

  test("a model with nothing to choose between is left alone", async () => {
    const target = store();
    const asked = levelled(target, []);
    feed(target, attached("s1"));

    await target.cycleThinking();
    expect(asked).toEqual([]);
  });
});

describe("the turn lease", () => {
  function state(
    extra: Partial<Extract<ServerEvent, { type: "session_state" }>> = {}
  ): ServerEvent {
    return {
      type: "session_state",
      writable: true,
      cwd: "/repo",
      model: "sonnet",
      thinking: "off",
      cost: 0,
      status: "idle",
      ...extra,
    };
  }

  function sent(target: SessionStore): readonly string[] {
    const types: string[] = [];
    target.client.send = (async (command: { readonly type: string }) => {
      types.push(command.type);
      return { type: "response", id: "1", success: true };
    }) as typeof target.client.send;
    return types;
  }

  test("names the surface that has it, and says nothing once it is free", () => {
    const target = store();
    feed(target, attached("s1"));
    expect(target.heldNotice()).toBeUndefined();

    feed(
      target,
      state({ writable: false, heldBy: { frontend: "tui", pid: 42 } })
    );
    expect(target.heldNotice()).toBe(
      "Running in the terminal — you can continue when this turn ends."
    );

    feed(
      target,
      state({ writable: false, heldBy: { frontend: "daemon", pid: 43 } })
    );
    expect(target.heldNotice()).toContain("in another window");

    feed(target, state());
    expect(target.heldNotice()).toBeUndefined();
  });

  test("refuses every intent that would write, and takes them back on release", async () => {
    const target = store();
    const types = sent(target);
    feed(
      target,
      attached("s1"),
      state({ writable: false, heldBy: { frontend: "tui", pid: 42 } })
    );

    await target.prompt("carry on without me");
    await target.setModel("opus");
    await target.setThinking("high");
    await target.cancel();
    await target.dequeue();
    flush();

    expect(types).toEqual([]);
    expect(target.state.optimistic).toEqual([]);

    feed(target, state());
    await target.prompt("carry on without me");
    flush();

    expect(types).toEqual(["user_message"]);
    expect(
      rows(target).map((row) => row.kind === "message" && row.text)
    ).toEqual(["carry on without me"]);
  });

  test("a fresh attach starts writable", () => {
    const target = store();
    feed(
      target,
      attached("s1"),
      state({ writable: false, heldBy: { frontend: "tui", pid: 42 } })
    );
    expect(target.state.writable).toBe(false);

    feed(target, attached("s2"));
    expect(target.state.writable).toBe(true);
    expect(target.state.heldBy).toBeUndefined();
  });
});

describe("attention", () => {
  function looking(visible: boolean, focused: boolean): void {
    Object.defineProperty(document, "visibilityState", {
      value: visible ? "visible" : "hidden",
      configurable: true,
    });
    Object.defineProperty(document, "hasFocus", {
      value: () => focused,
      configurable: true,
    });
  }

  afterEach(() => {
    Reflect.deleteProperty(document, "visibilityState");
    Reflect.deleteProperty(document, "hasFocus");
  });

  test("a tab that is already hidden says so before it attaches", () => {
    looking(false, true);
    const target = store();

    expect(target.client.attentive).toBe(false);
    target.dispose();
  });

  test("losing and regaining the reader is declared, until the store is gone", () => {
    const target = store();
    expect(target.client.attentive).toBe(true);

    looking(true, false);
    window.dispatchEvent(new Event("blur"));
    expect(target.client.attentive).toBe(false);

    looking(true, true);
    window.dispatchEvent(new Event("focus"));
    expect(target.client.attentive).toBe(true);

    looking(false, true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(target.client.attentive).toBe(false);

    target.dispose();
    looking(true, true);
    window.dispatchEvent(new Event("focus"));
    expect(target.client.attentive).toBe(false);
  });
});

describe("extension commands", () => {
  type Sent = Record<string, unknown> & { readonly type: string };

  function wire(target: SessionStore): readonly Sent[] {
    const sent: Sent[] = [];
    target.client.send = (async (command: Sent) => {
      sent.push(command);
      return {
        type: "response",
        id: "1",
        success: true,
        ...(typeof command.text === "string" && command.text.startsWith("/")
          ? { dispatched: true }
          : {}),
      };
    }) as typeof target.client.send;
    return sent;
  }

  function gate(target: SessionStore): {
    readonly answer: (index: number, response?: Partial<ResponseEvent>) => void;
  } {
    const waiting: ((response: ResponseEvent) => void)[] = [];
    target.client.send = (() =>
      new Promise<ResponseEvent>((resolve) => {
        waiting.push(resolve);
      })) as typeof target.client.send;
    return {
      answer: (index, response) => {
        waiting[index]?.({
          type: "response",
          id: `${index}`,
          success: true,
          ...response,
        });
      },
    };
  }

  function streaming(): ServerEvent {
    return {
      type: "session_state",
      writable: true,
      cwd: "/repo",
      model: "sonnet",
      thinking: "off",
      cost: 0,
      status: "streaming",
    };
  }

  function notice(id: string, text: string, command?: string): ServerEvent {
    return {
      type: "ui_notice",
      id,
      severity: "info",
      text,
      ...(command === undefined ? {} : { command }),
    };
  }

  function ask(requestId: string, title: string): ServerEvent {
    return { type: "ui_request", requestId, method: "confirm", title };
  }

  test("a dispatched message leaves no row, and no opening to name the session by", async () => {
    const target = store();
    wire(target);
    feed(target, attached("s1"));

    await target.prompt("/claude-quota");
    flush();

    expect(target.state.optimistic).toEqual([]);
    expect(rows(target)).toEqual([]);
    expect(target.state.openings).toEqual({});
  });

  // Regression: the next message used to reconcile against the dispatched
  // command's row.
  test("the next real message reconciles against itself", async () => {
    const target = store();
    wire(target);
    feed(target, attached("s1"));

    await target.prompt("/claude-quota");
    await target.prompt("what is the quota");
    flush();

    expect(
      rows(target).map((row) => row.kind === "message" && row.text)
    ).toEqual(["what is the quota"]);

    feed(target, {
      seq: 2,
      type: "message",
      messageId: "m1",
      role: "user",
      text: "what is the quota",
      timestamp: 0,
    });

    expect(target.state.optimistic).toEqual([]);
    expect(rows(target).map((row) => row.id)).toEqual(["m1"]);
  });

  test("a command typed into a running turn leaves the queued message whole", async () => {
    const target = store();
    wire(target);
    feed(target, attached("s1"), streaming());

    await target.prompt("use the other file");
    await target.prompt("/claude-quota");
    flush();

    expect(target.state.optimistic).toHaveLength(1);
    expect(
      rows(target).map((row) => row.kind === "message" && row.text)
    ).toEqual(["use the other file"]);
  });

  test("a dispatch takes back its own words, not the message queued into them", async () => {
    const target = store();
    const { answer } = gate(target);
    feed(target, attached("s1"), streaming());

    const dispatched = target.prompt("/claude-quota");
    const queued = target.prompt("use the other file");
    answer(0, { dispatched: true });
    await dispatched;
    flush();

    expect(
      target.state.optimistic.map((row) => [row.text, row.queued === true])
    ).toEqual([["use the other file", true]]);

    answer(1, { success: false, error: "the server refused the message" });
    expect(await queued).toBe(false);
    flush();

    expect(target.state.optimistic).toEqual([]);
  });

  test("and the same two answered the other way round leave the same nothing", async () => {
    const target = store();
    const { answer } = gate(target);
    feed(target, attached("s1"), streaming());

    const dispatched = target.prompt("/claude-quota");
    const queued = target.prompt("use the other file");
    answer(1, { success: false, error: "the server refused the message" });
    expect(await queued).toBe(false);
    flush();

    expect(target.state.optimistic.map((row) => row.text)).toEqual([
      "/claude-quota",
    ]);

    answer(0, { dispatched: true });
    await dispatched;
    flush();

    expect(target.state.optimistic).toEqual([]);
  });

  test("what one dispatch says stacks for the modal; the rest are toasts", () => {
    const target = store();
    feed(
      target,
      attached("s1"),
      notice("n1", "## Claude Quotas", "/claude-quota"),
      notice("n2", "Cache enabled.", "/claude-quota"),
      notice("n3", "The cache finished warming.")
    );

    expect(
      target.state.notices.map((held) => [held.text, held.command])
    ).toEqual([
      ["## Claude Quotas", "/claude-quota"],
      ["Cache enabled.", "/claude-quota"],
    ]);
    expect(target.state.toasts.map((held) => held.id)).toEqual(["n3"]);

    target.dismissToast("n3");
    target.closeCommand();
    flush();

    expect(target.state.toasts).toEqual([]);
    expect(target.state.notices).toEqual([]);
  });

  test("a dialog is answered once, and the answer names the request", () => {
    const target = store();
    const sent = wire(target);
    feed(target, attached("s1"), ask("r1", "Drop the table?"));

    expect(target.state.requests.map((held) => held.requestId)).toEqual(["r1"]);

    target.answerRequest("r1", { confirmed: true });
    target.answerRequest("r1", { confirmed: false });
    flush();

    expect(sent).toEqual([
      {
        type: "ui_response",
        sessionId: "s1",
        requestId: "r1",
        confirmed: true,
      },
    ]);
    expect(target.state.requests).toEqual([]);
  });

  test("a second question waits behind the first, and each is answered by name", () => {
    const target = store();
    const sent = wire(target);
    feed(
      target,
      attached("s1"),
      ask("r1", "Drop the table?"),
      ask("r2", "Sign out everywhere?")
    );

    expect(target.state.requests.map((held) => held.requestId)).toEqual([
      "r1",
      "r2",
    ]);

    target.answerRequest("r2", { confirmed: true });
    flush();

    expect(target.state.requests.map((held) => held.requestId)).toEqual(["r1"]);
    expect(sent.map((command) => command.requestId)).toEqual(["r2"]);
  });

  test("a dialog settled out from under the modal takes its control with it", () => {
    const target = store();
    const sent = wire(target);
    feed(target, attached("s1"), {
      type: "ui_request",
      requestId: "r1",
      method: "input",
      title: "Paste the code",
    });

    feed(target, { type: "ui_request_done", requestId: "r1" });

    expect(target.state.requests).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("dismissal is cancellation, and only while something is pending", () => {
    const target = store();
    const sent = wire(target);
    feed(target, attached("s1"), notice("n1", "Signing in…", "/login"), {
      type: "ui_request",
      requestId: "r1",
      method: "input",
      title: "Paste the code",
    });

    target.closeCommand();
    flush();

    expect(sent).toEqual([
      {
        type: "ui_response",
        sessionId: "s1",
        requestId: "r1",
        cancelled: true,
      },
    ]);
    expect(target.state.notices).toEqual([]);

    target.closeCommand();
    expect(sent).toHaveLength(1);
  });

  test("closing cancels every question it was holding", () => {
    const target = store();
    const sent = wire(target);
    feed(
      target,
      attached("s1"),
      ask("r1", "Drop the table?"),
      ask("r2", "Sign out everywhere?")
    );

    target.closeCommand();
    flush();

    expect(sent).toEqual([
      {
        type: "ui_response",
        sessionId: "s1",
        requestId: "r1",
        cancelled: true,
      },
      {
        type: "ui_response",
        sessionId: "s1",
        requestId: "r2",
        cancelled: true,
      },
    ]);
    expect(target.state.requests).toEqual([]);
  });

  test("another session's words do not follow the reader into this one", () => {
    const target = store();
    feed(
      target,
      attached("s1"),
      notice("n1", "## Claude Quotas", "/claude-quota"),
      ask("r1", "Drop the table?")
    );

    feed(target, attached("s2"));

    expect(target.state.notices).toEqual([]);
    expect(target.state.requests).toEqual([]);
  });

  test("nor does a question the server settled while the socket was down", () => {
    const target = store();
    feed(
      target,
      attached("s1"),
      notice("n1", "Signing in…", "/login"),
      ask("r1", "Drop the table?")
    );

    feed(target, attached("s1"));

    expect(target.state.notices).toEqual([]);
    expect(target.state.requests).toEqual([]);
  });
});
