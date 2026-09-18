import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import type { SessionHost } from "#core/session/SessionHost";
import type { GitState } from "#core/shared/Git";
import { GitMonitor } from "#core/shared/GitMonitor";
import type { EphemeralEvent, ServerEvent } from "#protocol/ServerEvent";
import { SessionStream } from "./SessionStream";

let tmp: string;
let path: string;
let stream: SessionStream;
let seen: ServerEvent[];
let stopListening: () => void;
let emit: (event: AgentSessionEvent) => void;
let reportForeign: () => void;

/**
 * A name this file owns. Tool views are registered process-wide by name, and
 * the suite is one process: a name another test file registers a view for
 * would paint these synthetic calls with that file's view, which reads a
 * `details` shape the events here have no reason to carry.
 */
const TOOL = "stream_probe";

/** Enough of a host for the stream to read a cwd and a status off, and to subscribe to. */
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
    leaseState: { writable: true },
    onLeaseChange: () => () => {},
    onForeignWrite: (listener: () => void) => {
      reportForeign = listener;
      return () => {};
    },
    subscribe: (listener: (event: AgentSessionEvent) => void) => {
      emit = listener;
      return () => {};
    },
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

/** Every state frame a client was handed, in the order it was sent. */
function states(): readonly Extract<
  EphemeralEvent,
  { type: "session_state" }
>[] {
  return received().filter((event) => event.type === "session_state");
}

/** Every durable message a client was handed, whole, so a second copy of one shows up. */
function durableMessages(): readonly string[] {
  return received().flatMap((event) =>
    event.type === "message" ? [`${event.role}: ${event.text}`] : []
  );
}

function notices(
  events: readonly ServerEvent[]
): readonly Extract<ServerEvent, { type: "ui_notice" }>[] {
  return events.filter((event) => event.type === "ui_notice");
}

function askedIn(
  events: readonly ServerEvent[]
): Extract<ServerEvent, { type: "ui_request" }> {
  const asked = events.find((event) => event.type === "ui_request");
  if (asked?.type !== "ui_request") {
    throw new Error("no ui_request was sent");
  }
  return asked;
}

function requestIdOf(events: readonly ServerEvent[]): string {
  return askedIn(events).requestId;
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
  stopListening = stream.subscribe((event) => {
    seen.push(event);
  });
  stream.start();
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
  running.start();
  const start = emit;

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

/**
 * The transcript is file-derived and stays right, but a writer that took no
 * lease may have forked the history behind it, and only the client can judge
 * what to do about that.
 */
test("tells attached clients when the host sees a write it cannot account for", () => {
  reportForeign();
  expect(received().filter((event) => event.type === "error")).toEqual([
    {
      type: "error",
      message:
        "Another process is writing this session; its history may be inconsistent.",
    },
  ]);
});

/**
 * A turn run in the terminal reaches this process as nothing but lines in the
 * file: the agent it belongs to lives elsewhere, so not one `AgentSessionEvent`
 * fires here. `fs.watch` is stubbed away because it reports nothing at all on
 * some filesystems, which leaves the poll as the only thing that can notice.
 */
test("carries a foreign turn to a client on the poll alone, with no agent event", async () => {
  const watching = spyOn(fs, "watch");
  watching.mockImplementation((() => {
    throw new Error("this filesystem reports nothing");
  }) as never);
  try {
    stream.dispose();
    seen = [];
    stream = new SessionStream("s1", host(), path, { pollMs: 5 });
    stream.subscribe((event) => {
      seen.push(event);
    });
    stream.start();
    stream.watchFiles(true);
    expect(watching).toHaveBeenCalled();

    await persist("u1", {
      role: "user",
      content: [{ type: "text", text: "from the terminal" }],
    });
    await persistAssistant("a1", [{ type: "text", text: "and the reply" }]);
    await until(
      () => durableMessages().length === 2,
      "the foreign turn to be tailed"
    );
    expect(durableMessages()).toEqual([
      "user: from the terminal",
      "assistant: and the reply",
    ]);
    // Nothing was streamed, so nothing is standing live over the two entries.
    expect(liveIds().size).toBe(0);

    // Every later read is a read past the same cursor, whoever asks for it.
    await stream.refresh();
    await stream.replay(0);
    expect(durableMessages()).toHaveLength(2);
  } finally {
    watching.mockRestore();
  }
});

/** A worktree edit touches nothing under `.git`, so a tool that writes has to say so itself. */
test("re-reads the repository as soon as a tool has written to it", async () => {
  let next: GitState = {
    branch: "main",
    dirtyCount: 0,
    ahead: 0,
    behind: 0,
    revision: "r0",
  };
  let reads = 0;
  const git = new GitMonitor({
    status: () => {
      reads += 1;
      return Promise.resolve(next);
    },
    pollMs: 60_000,
  });
  stream.dispose();
  seen = [];
  stream = new SessionStream("s1", host(), path, { git });
  stream.subscribe((event) => {
    seen.push(event);
  });
  stream.start();
  stream.watchFiles(true);
  await until(() => reads === 1, "the reading the watch asks for");

  next = { ...next, dirtyCount: 3, revision: "r1" };
  emit(
    agentEvent({
      type: "tool_execution_end",
      toolCallId: "call_write",
      toolName: TOOL,
      result: { content: [] },
      isError: false,
    })
  );

  await until(
    () => states().some((state) => state.repoRevision === "r1"),
    "the frame the write produced"
  );
  expect(states().at(-1)?.dirtyCount).toBe(3);
});

/**
 * An extension may notify from any handler it likes, so a cache that finished
 * warming must not open the modal an answer to a typed command deserves.
 */
test("names the command what a dispatch said, and nothing else", async () => {
  stream.notify("the cache warmed itself", "info");
  await stream.dispatch("/quota", async () => {
    stream.notify("## Quotas\n\n- plenty", "info");
  });

  expect(
    notices(received()).map((notice) => [notice.text, notice.command])
  ).toEqual([
    ["the cache warmed itself", undefined],
    ["## Quotas\n\n- plenty", "/quota"],
  ]);
});

/** The panel is titled by whoever opened it, and a question may open it alone. */
test("names the command a dialog it raised, innermost first", async () => {
  const asked = stream.dispatch("/login", async () =>
    stream.dispatch("/auth", async () => {
      const asking = stream.confirm("Open the browser?", "it takes a moment");
      stream.answer(requestIdOf(received()), { confirmed: true });
      return asking;
    })
  );

  expect(await asked).toBe(true);
  expect(askedIn(received()).command).toBe("/auth");
});

/** A headless session cannot park an extension on a dialog nobody will ever see. */
test("takes pi's default for a dialog raised with nobody attached", async () => {
  stopListening();

  expect(await stream.confirm("Drop the table?", "there is no undo")).toBe(
    false
  );
  expect(await stream.select("Pick one", ["a", "b"])).toBeUndefined();
  expect(received().some((event) => event.type === "ui_request")).toBe(false);
});

test("resolves one dialog once, however many clients are watching it", async () => {
  const second: ServerEvent[] = [];
  stream.subscribe((event) => {
    second.push(event);
  });

  const asking = stream.select("Pick one", ["a", "b"]);
  const requestId = requestIdOf(received());
  expect(stream.answer(requestId, { value: "a" })).toBe(true);
  // The second client's click raced the first's and lost; applying it too
  // would answer whatever the extension asked next.
  expect(stream.answer(requestId, { value: "b" })).toBe(false);

  expect(await asking).toBe("a");
  const done = (events: readonly ServerEvent[]): number =>
    events.filter((event) => event.type === "ui_request_done").length;
  expect(done(received())).toBe(1);
  expect(done(second)).toBe(1);
});

/** Dismissal is cancellation, which is what pi's own dialogs answer with. */
test("takes the default from a client that dismissed the dialog", async () => {
  const asking = stream.confirm("Drop the table?", "there is no undo");

  expect(stream.answer(requestIdOf(received()), { cancelled: true })).toBe(
    true
  );
  expect(await asking).toBe(false);
});

test("answers a dialog itself once its last reader is gone", async () => {
  const parting = new SessionStream("s6", host(), path, { detachGraceMs: 0 });
  const stop = parting.subscribe(() => {});
  try {
    const asking = parting.confirm("Still there?", "answer within the grace");
    stop();

    expect(await asking).toBe(false);
  } finally {
    parting.dispose();
  }
});

/** A reload, a tunnel blip and a phone unlock are all detaches, and all three come back. */
test("calls the grace off for a client that came straight back", async () => {
  const parting = new SessionStream("s7", host(), path, { detachGraceMs: 0 });
  const events: ServerEvent[] = [];
  const stop = parting.subscribe((event) => {
    events.push(event);
  });
  try {
    const asking = parting.confirm("Still there?", "answer within the grace");
    stop();
    const returned: ServerEvent[] = [];
    parting.subscribe((event) => {
      events.push(event);
    });
    // One macrotask: the grace timer would have fired here had it survived.
    await Bun.sleep(0);
    // And the client that came back is asked again: it never saw the frame
    // the dialog was announced on, and it is the only one who can answer now.
    returned.push(...(await parting.replay(99)));
    expect(
      returned.filter((event) => event.type === "ui_request")
    ).toHaveLength(1);

    expect(parting.answer(requestIdOf(events), { confirmed: true })).toBe(true);
    expect(await asking).toBe(true);
  } finally {
    parting.dispose();
  }
});

test("answers a dialog nobody got to before the ceiling, and says which", async () => {
  const impatient = new SessionStream("s8", host(), path, {
    requestCeilingMs: 0,
  });
  const events: ServerEvent[] = [];
  impatient.subscribe((event) => {
    events.push(event);
  });
  try {
    expect(
      await impatient.input("Name the branch", "feature/…")
    ).toBeUndefined();

    // Never silently: a dialog that answers itself in silence is the
    // invisible mutation this whole seam exists to kill.
    const notice = notices(events).at(-1);
    expect(notice?.severity).toBe("warn");
    expect(notice?.text).toContain("Name the branch");
    expect(
      events.filter((event) => event.type === "ui_request_done")
    ).toHaveLength(1);
  } finally {
    impatient.dispose();
  }
});

test("lets an extension's own timeout beat the ceiling", async () => {
  const impatient = new SessionStream("s9", host(), path, {
    requestCeilingMs: 60_000,
  });
  const events: ServerEvent[] = [];
  impatient.subscribe((event) => {
    events.push(event);
  });
  try {
    // The ceiling is a minute out, so a suite that finishes in seconds can
    // only settle this on the schedule the extension asked for.
    expect(
      await impatient.select("Pick one", ["a", "b"], { timeout: 0 })
    ).toBeUndefined();

    const notice = notices(events).at(-1);
    expect(notice?.severity).toBe("warn");
    expect(notice?.text).toContain("Pick one");
  } finally {
    impatient.dispose();
  }
});

test("hands a dialog its default when the extension withdraws it", async () => {
  const controller = new AbortController();

  const asking = stream.confirm("Drop the table?", "there is no undo", {
    signal: controller.signal,
  });
  controller.abort();

  expect(await asking).toBe(false);
  expect(
    received().filter((event) => event.type === "ui_request_done")
  ).toHaveLength(1);
});

test("settles every waiting dialog when the session stops", async () => {
  const asking = stream.input("Name the branch");

  stream.dispose();

  expect(await asking).toBeUndefined();
});
