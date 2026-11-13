import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import * as fs from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { JobView } from "#core/extensions/subagent/SubagentJobs";
import { SubagentResult } from "#core/extensions/subagent/SubagentResult";
import type { SessionHost } from "#core/session/SessionHost";
import type { GitState } from "#core/shared/Git";
import { GitMonitor } from "#core/shared/GitMonitor";
import { git as runGit } from "#core/shared/fixtures/repo";
import { NestedRepos } from "#core/shared/NestedRepos";
import type { EphemeralEvent, ServerEvent } from "#protocol/ServerEvent";
import { until } from "#core/shared/fixtures/wait";
import { SessionStream } from "./SessionStream";

let tmp: string;
let path: string;
let stream: SessionStream;
let seen: ServerEvent[];
let stopListening: () => void;
let emit: (event: AgentSessionEvent) => void;
let queued: string[];
let jobs: readonly JobView[];
let jobsChanged: () => void;

/** Unique so no other test file's registered view paints these calls. */
const TOOL = "stream_probe";

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
    get queued() {
      return queued;
    },
    get jobs() {
      return jobs;
    },
    onJobsChange: (listener: () => void) => {
      jobsChanged = listener;
      return () => {};
    },
    leaseState: { writable: true },
    subagentChoice: {},
    onLeaseChange: () => () => {},
    onForeignWrite: () => () => {},
    subscribe: (listener: (event: AgentSessionEvent) => void) => {
      emit = listener;
      return () => {};
    },
  } as unknown as SessionHost;
}

function agentEvent(event: Record<string, unknown>): AgentSessionEvent {
  return event as unknown as AgentSessionEvent;
}

function thinkingMessage(thinking: string): Record<string, unknown> {
  return { role: "assistant", content: [{ type: "thinking", thinking }] };
}

async function append(entry: Record<string, unknown>): Promise<void> {
  await Bun.write(
    path,
    `${await Bun.file(path).text()}${JSON.stringify(entry)}\n`
  );
}

async function persist(
  id: string,
  message: Record<string, unknown>
): Promise<void> {
  await append({
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message,
  });
}

async function persistAssistant(
  id: string,
  content: readonly Record<string, unknown>[]
): Promise<void> {
  await persist(id, { role: "assistant", content });
}

async function persistToolResult(
  callId: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await persist(`r-${callId}`, {
    role: "toolResult",
    toolCallId: callId,
    toolName: TOOL,
    content: [],
    isError: false,
    ...extra,
  });
}

/** Streams a step, persists it, then closes it. */
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
  await stream.refresh();
  await until(() => durableThinking().includes(thinking), `the entry ${id}`);
}

/** Received events with `replay` envelopes flattened. */
function received(): readonly ServerEvent[] {
  return seen.flatMap((event): readonly ServerEvent[] =>
    event.type === "replay" ? event.events : [event]
  );
}

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

function states(): readonly Extract<
  EphemeralEvent,
  { type: "session_state" }
>[] {
  return received().filter((event) => event.type === "session_state");
}

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
  queued = [];
  jobs = [];
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

test("retires the step an entry belongs to, not the oldest live message", async () => {
  await step("step one", "a1");

  // Pi runs a message's calls after writing its entry, so they open a new live shell.
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
  expect(liveThinking()).toEqual([]);
});

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
  // Still reported until the durable result lands.
  const running = await stream.replay(99);
  expect(running.filter((event) => event.type === "tool_end")).toHaveLength(1);

  await persistToolResult("call_1");
  emit(agentEvent({ type: "entry_appended" }));
  await until(
    () => received().some((event) => event.type === "tool_result"),
    "the result to be read out of the log"
  );

  const settled = await stream.replay(99);
  expect(settled.filter((event) => event.type === "tool_call")).toEqual([]);
});

test("carries how long a call ran, live, on reattach and from the log", async () => {
  emit(agentEvent({ type: "message_start", message: thinkingMessage("") }));
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
      durationMs: 1234,
    })
  );
  const ends = (events: readonly ServerEvent[]) =>
    events.flatMap((event) =>
      event.type === "tool_end" || event.type === "tool_result"
        ? [[event.type, event.durationMs]]
        : []
    );
  expect(ends(received())).toEqual([["tool_end", 1234]]);
  expect(ends(await stream.replay(99))).toEqual([["tool_end", 1234]]);

  await persistToolResult("call_1", { durationMs: 1234 });
  emit(agentEvent({ type: "entry_appended" }));
  await until(
    () => received().some((event) => event.type === "tool_result"),
    "the result to be read out of the log"
  );
  expect(ends(received()).at(-1)).toEqual(["tool_result", 1234]);
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

    status = "idle";
    expect(stateOf(running).turnElapsedMs).toBeUndefined();
  } finally {
    Date.now = real;
    running.dispose();
  }
});

test("the state says whether the last turn was interrupted", () => {
  emit(agentEvent({ type: "agent_start" }));
  emit(agentEvent({ type: "agent_settled", aborted: true }));
  expect(stateOf(stream).interrupted).toBe(true);

  emit(agentEvent({ type: "agent_start" }));
  expect(stateOf(stream).interrupted).toBeUndefined();
  emit(agentEvent({ type: "agent_settled", aborted: false }));
  expect(stateOf(stream).interrupted).toBeUndefined();
});

test("tells clients what is queued as the queue changes", () => {
  queued = [
    "use the other file",
    "[Image attachment: /up/s1/tide-1700000000000.png]",
  ];
  emit(agentEvent({ type: "queue_update" }));
  expect(states().at(-1)?.queued).toEqual({
    text: "use the other file",
    attachments: [
      {
        name: "tide.png",
        url: "/attachment/s1/tide-1700000000000.png",
        isImage: true,
      },
    ],
  });

  queued = [];
  emit(agentEvent({ type: "queue_update" }));
  expect(states().at(-1)?.queued).toBeUndefined();
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
    expect(liveIds().size).toBe(0);

    // Later reads must not resend them.
    await stream.refresh();
    await stream.replay(0);
    expect(durableMessages()).toHaveLength(2);
  } finally {
    watching.mockRestore();
  }
});

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
  expect(stream.answer(requestId, { value: "b" })).toBe(false);

  expect(await asking).toBe("a");
  const done = (events: readonly ServerEvent[]): number =>
    events.filter((event) => event.type === "ui_request_done").length;
  expect(done(received())).toBe(1);
  expect(done(second)).toBe(1);
});

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
    // Give a surviving grace timer the chance to fire.
    await Bun.sleep(0);
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

const JOB: JobView = {
  id: "call_job",
  handle: "j1",
  title: "audit the parser",
  startedAt: 1_000,
  turns: 1,
  cost: 0.01,
};

function jobLists(): readonly (readonly JobView[])[] {
  return received().flatMap((event) =>
    event.type === "jobs" ? [event.jobs] : []
  );
}

test("tells clients which jobs run as they start and finish", () => {
  jobs = [JOB];
  jobsChanged();
  jobs = [];
  jobsChanged();

  expect(jobLists()).toEqual([[JOB], []]);
});

test("hands a reattaching client the running jobs, just before the state", async () => {
  jobs = [JOB];

  const replayed = await stream.replay(0);

  expect(replayed.slice(-2).map((event) => event.type)).toEqual([
    "jobs",
    "session_state",
  ]);
  expect(replayed.at(-2)).toEqual({ type: "jobs", jobs: [JOB] });
});

test("a live spawn links its job, and a spawn that fails links nothing", async () => {
  const start = (toolCallId: string): void => {
    emit(
      agentEvent({
        type: "tool_execution_start",
        toolCallId,
        toolName: "subagent",
        args: { action: "spawn", prompt: "audit the parser" },
      })
    );
  };
  const end = (toolCallId: string, details: unknown): void => {
    emit(
      agentEvent({
        type: "tool_execution_end",
        toolCallId,
        toolName: "subagent",
        result: { content: [{ type: "text", text: "" }], details },
        isError: details === undefined,
      })
    );
  };
  start("call_ok");
  start("call_bad");
  end("call_ok", {
    action: "spawn",
    jobId: "call_ok",
    handle: "j3",
    prompt: "audit the parser",
    owner: { pid: 1, hostname: "box" },
  });
  end("call_bad", undefined);
  const links = (events: readonly ServerEvent[]): readonly unknown[] =>
    events.flatMap((event) =>
      event.type === "tool_call" || event.type === "tool_end"
        ? [[event.type, event.callId, event.child]]
        : []
    );

  expect(links(received())).toEqual([
    ["tool_call", "call_ok", { jobId: "call_ok" }],
    ["tool_call", "call_bad", { jobId: "call_bad" }],
    ["tool_end", "call_ok", { jobId: "call_ok", handle: "j3" }],
    ["tool_end", "call_bad", undefined],
  ]);
  expect(links(await stream.replay(99))).toEqual([
    ["tool_call", "call_ok", { jobId: "call_ok", handle: "j3" }],
    ["tool_end", "call_ok", { jobId: "call_ok", handle: "j3" }],
    ["tool_call", "call_bad", undefined],
    ["tool_end", "call_bad", undefined],
  ]);
});

test("counts a running job as a running call, so its log can be watched", () => {
  jobs = [JOB];
  expect(stream.isRunning(JOB.id)).toBe(true);

  jobs = [];
  expect(stream.isRunning(JOB.id)).toBe(false);
});

test("carries a job's result to the client as soon as pi appends it", async () => {
  const result = await SubagentResult.fromLog(
    { jobId: JOB.id, handle: JOB.handle, prompt: JOB.title },
    "/missing/child.jsonl"
  );
  const message = { role: "custom", ...result, timestamp: 0 };

  await append({
    type: "custom_message",
    id: "c1",
    parentId: null,
    timestamp: new Date().toISOString(),
    ...result,
  });
  emit(agentEvent({ type: "message_start", message }));
  emit(agentEvent({ type: "message_end", message }));
  await until(
    () => received().some((event) => event.type === "subagent_result"),
    "the job's result"
  );

  expect(
    received().find((event) => event.type === "subagent_result")
  ).toMatchObject({
    type: "subagent_result",
    messageId: "c1",
    jobId: JOB.id,
    state: "interrupted",
  });
});

test("a lease left by a terminal that died holds nothing", async () => {
  const exited = Bun.spawn(["true"]);
  await exited.exited;
  await Bun.write(
    `${path}.lease`,
    JSON.stringify({
      pid: exited.pid,
      hostname: hostname(),
      frontend: "tui",
      startedAt: Date.now(),
    })
  );

  const state = (await stream.replay(0)).find(
    (event) => event.type === "session_state"
  );

  expect(state).toMatchObject({ writable: true });
  expect(state).not.toHaveProperty("heldBy");
});

describe("the chosen repository", () => {
  const outer: GitState = {
    branch: "main",
    dirtyCount: 0,
    ahead: 0,
    behind: 0,
    revision: "outer",
  };
  const nested: GitState = { ...outer, branch: "feat", revision: "nested" };
  let inner: string;
  let innerState: GitState;
  let gates: Map<string, Promise<void>>;
  let git: GitMonitor;
  let watched: SessionHost;

  /** Real, since `NestedRepos.verify` asks git; the readings stay stubbed. */
  async function init(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await runGit(dir, ["init", "--quiet"]);
  }

  function hold(dir: string): () => void {
    let release!: () => void;
    gates.set(
      dir,
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    return release;
  }

  beforeEach(async () => {
    inner = join(tmp, "inner");
    await init(inner);
    innerState = nested;
    gates = new Map();
    git = new GitMonitor({
      status: async (dir) => {
        await gates.get(dir);
        return dir === inner ? innerState : outer;
      },
      pollMs: 60_000,
    });
    stream.dispose();
    seen = [];
    watched = host();
    stream = new SessionStream("s1", watched, path, { git });
    stream.subscribe((event) => {
      seen.push(event);
    });
    stream.start();
    stream.watchFiles(true);
    await until(() => states().at(-1)?.branch === "main", "the cwd's state");
  });

  afterEach(() => {
    git.dispose();
  });

  test("is reported only once it is read, and its first reading is no branch switch", async () => {
    const from = seen.length;

    await stream.setRepo("inner");

    const since = received().slice(from);
    const reported = states().filter((state) => state.repo === "inner");
    expect(reported.length).toBeGreaterThan(0);
    expect(reported.every((state) => state.branch === "feat")).toBe(true);
    expect(since.some((event) => event.type === "picker_invalidate")).toBe(
      false
    );
  });

  test("is not taken once the cwd has moved on while it was read", async () => {
    const release = hold(inner);

    const choosing = stream.setRepo("inner");
    Object.assign(watched, { cwd: join(tmp, "elsewhere") });
    release();

    await expect(choosing).rejects.toThrow("the working directory changed");
    expect(stream.repo).toBe("");
  });

  test("is the latest choice, even when an earlier one is read last", async () => {
    await init(join(tmp, "other"));
    const release = hold(inner);

    const first = stream.setRepo("inner");
    await stream.setRepo("other");
    release();

    await expect(first).rejects.toThrow("a later choice superseded inner");
    expect(stream.repo).toBe("other");
    expect(states().at(-1)?.repo).toBe("other");
  });

  test("is dropped by a cwd change while it is still being read", async () => {
    const release = hold(inner);

    const choosing = stream.setRepo("inner");
    await stream.syncGit();
    release();

    await expect(choosing).rejects.toThrow("a later choice superseded inner");
    expect(stream.repo).toBe("");
  });

  test("falls back to the cwd once its .git is gone, and says so", async () => {
    await stream.setRepo("inner");
    await rm(join(inner, ".git"), { recursive: true });

    await expect(stream.repository()).rejects.toThrow(
      "inner is no longer a git repository"
    );
    expect(stream.repo).toBe("");
    expect(states().at(-1)).toMatchObject({ branch: "main" });
    expect(states().at(-1)?.repo).toBeUndefined();
  });

  test("falls back to the cwd once it is a symlink to a repository outside the cwd", async () => {
    const outside = await mkdtemp(join(tmpdir(), "pim-outside-repo-"));
    try {
      await init(outside);
      await stream.setRepo("inner");
      await rm(inner, { recursive: true });
      await symlink(outside, inner);

      await expect(stream.repository()).rejects.toThrow(
        "inner is no longer a git repository"
      );
      expect(stream.repo).toBe("");
      expect(stream.gitDir).toBe(tmp);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("falls back to the cwd when the watch reads a repository whose .git is gone", async () => {
    await stream.setRepo("inner");
    const from = states().length;
    await rm(join(inner, ".git"), { recursive: true });
    innerState = outer;

    await git.refresh(inner);

    await until(() => stream.repo === "", "the watch to drop the repository");
    const after = states().slice(from);
    expect(after.at(-1)?.repo).toBeUndefined();
    expect(after.some((state) => state.repo === "inner")).toBe(false);
  });

  test("never takes a watch reading that a later one overtook", async () => {
    await stream.setRepo("inner");
    const verify = NestedRepos.verify;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const spy = spyOn(NestedRepos, "verify").mockImplementation(
      async (cwd, repo) => {
        calls += 1;
        await (calls === 1 ? held : verify(cwd, repo));
      }
    );

    try {
      innerState = { ...nested, branch: "stale", revision: "stale" };
      await git.refresh(inner);
      innerState = { ...nested, branch: "fresh", revision: "fresh" };
      await git.refresh(inner);
      await until(
        () => states().at(-1)?.branch === "fresh",
        "the later reading"
      );
      const settled = seen.length;
      release();
      await new Promise((resolve) => setImmediate(resolve));
      expect(calls).toBe(2);
      expect(seen.slice(settled)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
