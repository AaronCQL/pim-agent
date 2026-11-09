import { describe, expect, test } from "bun:test";
import type {
  AgentToolResult,
  BoundaryResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";

import { usePimHome } from "../../shared/fixtures/home";
import { until } from "../../shared/fixtures/wait";
import { SubagentLogs } from "../../shared/SubagentLogs";
import { assistant, HeldSession } from "./fixtures/session";
import subagent, { type SubagentOptions } from "./index";
import type { SpawnDetails, SubagentToolDetails } from "./schema";
import { SubagentJobs } from "./SubagentJobs";
import { SubagentResult, type SubagentResultMessage } from "./SubagentResult";

usePimHome("pim-subagent-ext-");

const PARENT = "parent-1";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

type Entry = Record<string, unknown>;

function load(options: SubagentOptions) {
  let tool: ToolDefinition | undefined;
  const handlers = new Map<string, Handler[]>();
  const pi = {
    registerTool: (def: ToolDefinition) => {
      tool = def;
    },
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    getActiveTools: () => ["read", "subagent"],
    getThinkingLevel: () => "low",
  } as unknown as ExtensionAPI;
  void subagent(options)(pi);

  const branch: Entry[] = [];
  /** Entries on the session's other branches. */
  const elsewhere: Entry[] = [];
  const ctx = {
    cwd: "/work",
    model: undefined,
    sessionManager: {
      getSessionId: () => PARENT,
      getBranch: () => branch,
      getEntries: () => [...elsewhere, ...branch],
    },
  } as unknown as ExtensionContext;

  const emit = async (
    event: string,
    payload: Record<string, unknown> = {}
  ): Promise<unknown> => {
    let result: unknown;
    for (const handler of handlers.get(event) ?? []) {
      result = await handler({ type: event, ...payload }, ctx);
    }
    return result;
  };

  /** A turn boundary as pi runs it: the proposal, committed to the branch. */
  const boundary = async (
    event: "turn_end" | "agent_before_settle",
    outcome = "completed"
  ): Promise<BoundaryResult | undefined> => {
    const proposal = (await emit(event, { outcome, entries: [] })) as
      | BoundaryResult
      | undefined;
    branch.push(
      ...((proposal?.entries ?? []) as readonly unknown[] as Entry[])
    );
    return proposal;
  };

  const call = async (
    id: string,
    args: Record<string, unknown>
  ): Promise<AgentToolResult<SubagentToolDetails>> => {
    const prepared = tool!.prepareArguments!(args);
    return (await tool!.execute(
      id,
      prepared as never,
      undefined,
      undefined,
      ctx as never
    )) as AgentToolResult<SubagentToolDetails>;
  };

  return {
    tool: () => tool!,
    ctx,
    handlers,
    emit,
    boundary,
    call,
    branch,
    elsewhere,
  };
}

function answers(branch: readonly Entry[], jobId: string): number {
  return branch.filter(
    (entry) =>
      entry["type"] === "custom_message" &&
      (entry["details"] as { readonly jobId?: string }).jobId === jobId
  ).length;
}

function textOf(result: AgentToolResult<unknown>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

function withJobs({ busy }: { readonly busy?: () => boolean } = {}) {
  const jobs = new SubagentJobs({ now: () => 1_000 });
  const sessions: HeldSession[] = [];
  const delivered: { result: SubagentResultMessage; wake: boolean }[] = [];
  const loaded = load({
    jobs,
    createSession: async () => {
      const session = new HeldSession();
      sessions.push(session);
      return session;
    },
  });
  jobs.attach(PARENT, async ({ result, wake }) => {
    if (busy?.() === true) {
      return "due";
    }
    const session = {
      getBranch: () => loaded.branch as never,
      getEntries: () => [...loaded.elsewhere, ...loaded.branch] as never,
    };
    const place = () => SubagentResult.placement(session, result.details.jobId);
    if (place() === "due") {
      delivered.push({ result, wake });
      loaded.branch.push({ type: "custom_message", ...result });
    }
    return place();
  });
  const spawn = async (id: string): Promise<HeldSession> => {
    await loaded.call(id, { action: "spawn", prompt: `task ${id}` });
    await until(() => sessions.length > 0, "the child session");
    const session = sessions.shift()!;
    await until(() => session.promptCalls === 1, "the child prompt");
    return session;
  };
  return { ...loaded, jobs, delivered, spawn };
}

describe("subagent tool, synchronous", () => {
  test("spawn awaits the child and answers with its output", async () => {
    const session = new HeldSession();
    const { call, tool } = load({ createSession: async () => session });

    const result = call("call-1", { prompt: "say hi" });
    await until(() => session.promptCalls === 1, "the child prompt");
    session.finish("hi");

    expect(textOf(await result)).toBe("hi");
    expect(tool().description).toContain("return its answer");
  });

  test("the schema offers no job actions", async () => {
    const { call } = load({});

    await expect(
      call("call-1", { action: "status", prompt: "x" })
    ).rejects.toThrow("action");
  });
});

describe("subagent tool, in the background", () => {
  test("spawn returns a handle at once and the job runs on", async () => {
    const { call, jobs, delivered, spawn } = withJobs();

    const session = await spawn("call-1");
    const list = await call("call-2", { action: "status" });

    expect(jobs.list(PARENT).map((job) => job.id)).toEqual(["call-1"]);
    expect(textOf(list)).toBe(
      "1 subagent job running:\n- j1 · 0s · 0 turns · $0.00 · task call-1"
    );
    session.finish("found it");
    await until(() => delivered.length === 1, "the result");
    expect(delivered[0]?.wake).toBe(true);
  });

  test("spawn details carry the job and the process that owns it", async () => {
    const { call, jobs } = withJobs();

    const result = await call("call-1", { action: "spawn", prompt: "task" });

    expect(textOf(result)).toBe(
      "Started job j1. You will be woken with its result; end your turn if you have nothing else to do."
    );
    expect(result.details).toEqual({
      action: "spawn",
      jobId: "call-1",
      handle: "j1",
      prompt: "task",
      owner: { pid: process.pid, hostname: hostname() },
    });
    await jobs.stopAll(PARENT, { by: "user" });
  });

  test("status lists every job, shows the one an id names in detail, and says when nothing runs", async () => {
    const { call, jobs, spawn } = withJobs();
    expect(textOf(await call("s0", { action: "status" }))).toBe(
      "No subagent jobs are running."
    );
    await spawn("a");
    await spawn("b");

    const listed = await call("s1", { action: "status" });
    expect(textOf(listed)).toBe(
      [
        "2 subagent jobs running:",
        "- j1 · 0s · 0 turns · $0.00 · task a",
        "- j2 · 0s · 0 turns · $0.00 · task b",
      ].join("\n")
    );
    expect(listed.details).toMatchObject({ action: "status" });
    expect(listed.details).not.toHaveProperty("id");

    const detailed = await call("s2", { action: "status", id: "j2" });
    expect(textOf(detailed)).toStartWith(
      "Job j2: running for 0s, 0 turns, $0.00\nPrompt: task b"
    );
    expect(detailed.details).toMatchObject({
      action: "status",
      id: "j2",
      jobs: [{ id: "b", handle: "j2" }],
    });
    expect(textOf(await call("s3", { action: "status", id: "a" }))).toStartWith(
      "Job j1: running for"
    );
    await expect(call("s4", { action: "status", id: "j9" })).rejects.toThrow(
      'No running subagent job with handle or id "j9"'
    );
    await jobs.stopAll(PARENT, { by: "user" });
  });

  test("stop names what it stopped; the partial output comes with the result", async () => {
    const { call, delivered, spawn } = withJobs();
    const session = await spawn("call-1");
    session.emit({
      type: "message_end",
      message: assistant(["so far"], { stopReason: "toolUse" }),
    });

    const result = await call("s1", {
      action: "stop",
      id: "j1",
      reason: "wrong approach",
    });

    expect(textOf(result)).toBe(
      "Stopped j1 (wrong approach); its result follows."
    );
    expect(result.details).toEqual({
      action: "stop",
      jobIds: ["call-1"],
      reason: "wrong approach",
    });
    await until(() => delivered.length === 1, "the result");
    expect(delivered[0]?.result.content).toStartWith(
      "[subagent job j1 stopped by agent: wrong approach]\nPartial output:\nso far"
    );
    expect(delivered[0]?.wake).toBe(false);
  });

  test("a call with a prompt and no action is a spawn, as older sessions taught", async () => {
    const { call, jobs } = withJobs();

    const result = await call("call-1", { prompt: "task" });

    expect(result.details).toMatchObject({ action: "spawn", handle: "j1" });
    await jobs.stopAll(PARENT, { by: "user" });
  });

  test("steer reaches the child", async () => {
    const { call, jobs, spawn } = withJobs();
    const session = await spawn("call-1");

    const result = await call("s1", {
      action: "steer",
      id: "j1",
      message: "skip docs",
    });

    expect(textOf(result)).toBe(
      "Sent to job j1; it reads it before its next step."
    );
    expect(result.details).toEqual({
      action: "steer",
      jobId: "call-1",
      message: "skip docs",
    });
    expect(session.steered).toEqual(["skip docs"]);
    await jobs.stopAll(PARENT, { by: "user" });
  });

  test.each([
    [{ action: "spawn" }, 'subagent action="spawn" needs "prompt"'],
    [{ action: "stop", reason: "r" }, 'subagent action="stop" needs "id"'],
    [{ action: "stop", id: "x" }, 'subagent action="stop" needs "reason"'],
    [{ action: "steer", message: "m" }, 'subagent action="steer" needs "id"'],
    [{ action: "steer", id: "x" }, 'subagent action="steer" needs "message"'],
  ])("%j is refused with what it lacks", async (args, message) => {
    const { call } = withJobs();

    await expect(call("c", args)).rejects.toThrow(message);
  });
});

describe("subagent prompt cache", () => {
  const payload = {
    system: [
      { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "hi", cache_control: { type: "ephemeral" } },
        ],
      },
    ],
  };
  const extended = {
    system: [
      {
        type: "text",
        text: "sys",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "hi",
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
        ],
      },
    ],
  };

  test("holds the cache for an hour only while the session has jobs running", async () => {
    const { ctx, emit, spawn, delivered } = withJobs();
    Object.assign(ctx, { model: { api: "anthropic-messages" } });
    const request = () => emit("before_provider_request", { payload });

    expect(await request()).toBeUndefined();
    const session = await spawn("call-1");
    expect(await request()).toEqual(extended);
    session.finish("done");
    await until(() => delivered.length === 1, "the result");
    expect(await request()).toBeUndefined();
  });

  test.each([
    { api: "openai-completions" },
    {
      api: "anthropic-messages",
      compat: { supportsLongCacheRetention: false },
    },
  ])("leaves a model without hour-long caching alone: %j", async (model) => {
    const { ctx, emit, spawn } = withJobs();
    Object.assign(ctx, { model });
    await spawn("call-1");
    expect(await emit("before_provider_request", { payload })).toBeUndefined();
  });
});

describe("subagent abort semantics", () => {
  test.each([true, false])(
    "a run that settles (aborted: %p) leaves the jobs running: only an explicit stop ends them",
    async (aborted) => {
      const { emit, jobs, spawn } = withJobs();
      await spawn("call-1");

      await emit("agent_start");
      await emit("agent_settled", { aborted });

      expect(jobs.hasRunning(PARENT)).toBe(true);
      await jobs.stopAll(PARENT, { by: "user" });
    }
  );
});

describe("subagent delivery at turn boundaries", () => {
  test("a busy run's turn boundary appends a held result once, continuing the run when it wakes", async () => {
    const { boundary, branch, jobs, spawn } = withJobs({ busy: () => true });
    const session = await spawn("call-1");
    session.finish("the answer");
    await until(() => !jobs.hasRunning(PARENT), "the job to finish");

    const proposal = await boundary("turn_end");

    expect(proposal).toMatchObject({
      entries: [
        {
          type: "custom_message",
          customType: "subagent_result",
          display: true,
          content:
            "[subagent job j1 done]\nthe answer\n\nNo other jobs running.",
          details: { jobId: "call-1", handle: "j1", state: "done" },
        },
      ],
      continue: true,
    });
    expect(await boundary("agent_before_settle")).toBeUndefined();
    expect(answers(branch, "call-1")).toBe(1);
    expect(jobs.hasPending(PARENT)).toBe(false);
  });

  test("a turn boundary holds a result whose spawn is on another branch until that branch is current", async () => {
    const { boundary, branch, elsewhere, emit, jobs, spawn } = withJobs({
      busy: () => true,
    });
    const session = await spawn("call-1");
    const spawned = {
      type: "message",
      message: { role: "toolResult", toolCallId: "call-1" },
    };
    elsewhere.push(spawned);
    session.finish("the answer");
    await until(() => !jobs.hasRunning(PARENT), "the job to finish");

    expect(await boundary("turn_end")).toBeUndefined();

    elsewhere.pop();
    branch.push(spawned);
    await emit("session_tree");

    expect((await boundary("turn_end"))?.entries).toHaveLength(1);
    expect(answers(branch, "call-1")).toBe(1);
  });

  test.each(["session_compact", "session_compact_failed", "session_tree"])(
    "%s retries the held results, as no run settles after it",
    async (event) => {
      let busy = true;
      const { delivered, emit, jobs, spawn } = withJobs({ busy: () => busy });
      const session = await spawn("call-1");
      session.finish("the answer");
      await until(() => !jobs.hasRunning(PARENT), "the job to finish");

      busy = false;
      await emit(event);
      await until(() => delivered.length === 1, "the delivery");

      expect(delivered[0]?.wake).toBe(true);
    }
  );

  test("a result that does not wake is appended without continuing the run", async () => {
    const { boundary, call, spawn } = withJobs({ busy: () => true });
    await spawn("call-1");
    await call("s1", { action: "stop", id: "j1", reason: "enough" });

    const proposal = await boundary("turn_end");

    expect(proposal?.entries).toHaveLength(1);
    expect(proposal?.continue).toBeUndefined();
  });

  test.each(["aborted", "error"])(
    "a turn that ends %s leaves its held results to the settled run, which delivers them",
    async (outcome) => {
      let busy = true;
      const { boundary, branch, delivered, emit, jobs, spawn } = withJobs({
        busy: () => busy,
      });
      const session = await spawn("call-1");
      session.finish("the answer");
      await until(() => !jobs.hasRunning(PARENT), "the job to finish");

      expect(await boundary("turn_end", outcome)).toBeUndefined();
      busy = false;
      await emit("agent_settled", { aborted: outcome === "aborted" });
      await until(() => delivered.length === 1, "the delivery");

      expect(delivered[0]?.wake).toBe(true);
      expect(answers(branch, "call-1")).toBe(1);
    }
  );
});

describe("subagent reconcile", () => {
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;

  function spawnEntry(
    jobId: string,
    owner = { pid: 2 ** 22 + 1, hostname: hostname() }
  ): Entry {
    const details: SpawnDetails = {
      action: "spawn",
      jobId,
      handle: "j7",
      prompt: `task ${jobId}`,
      owner,
    };
    return {
      type: "message",
      id: `tr-${jobId}`,
      message: {
        role: "toolResult",
        toolCallId: jobId,
        toolName: "subagent",
        content: [{ type: "text", text: "Started" }],
        details,
        isError: false,
      },
    };
  }

  async function writeLog(
    jobId: string,
    messages: readonly unknown[]
  ): Promise<string> {
    const path = SubagentLogs.pathFor(PARENT, jobId)!;
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(
      path,
      line({
        type: "session",
        version: 3,
        id: "child",
        timestamp: "2026-11-08T00:00:00.000Z",
        cwd: "/work",
      }) +
        messages
          .map((message, index) =>
            line({
              type: "message",
              id: `m${index}`,
              parentId: index === 0 ? null : `m${index - 1}`,
              timestamp: "2026-11-08T00:00:01.000Z",
              message,
            })
          )
          .join("")
    );
    return path;
  }

  test("a lost job whose child finished is delivered as done, without waking", async () => {
    const { emit, branch, delivered } = withJobs();
    branch.push(spawnEntry("lost-done"));
    await writeLog("lost-done", [
      assistant(["looking"], { stopReason: "toolUse" }),
      assistant(["the answer"]),
    ]);

    await emit("session_start", { reason: "startup" });
    await until(() => delivered.length === 1, "the reconciled result");

    expect(delivered[0]?.wake).toBe(false);
    expect(delivered[0]?.result.content).toBe(
      "[subagent job j7 done]\nthe answer"
    );
    expect(delivered[0]?.result.details).toMatchObject({
      state: "done",
      handle: "j7",
      prompt: "task lost-done",
    });
    expect(delivered[0]?.result.details.usage.turns).toBe(2);
  });

  test("a lost job cut off mid-run is delivered as interrupted, pointing at its log", async () => {
    const { emit, branch, delivered } = withJobs();
    branch.push(spawnEntry("lost-mid"));
    const path = await writeLog("lost-mid", [
      assistant([], {
        stopReason: "toolUse",
        content: [
          { type: "text", text: "checking the parser" },
          {
            type: "toolCall",
            id: "t1",
            name: "mcp_lookup",
            arguments: { query: "callers" },
          },
        ],
      }),
    ]);

    await emit("agent_settled", { aborted: false });
    await until(() => delivered.length === 1, "the reconciled result");

    expect(delivered[0]?.result.details.state).toBe("interrupted");
    expect(delivered[0]?.result.details.logPath).toBe(path);
    expect(delivered[0]?.result.content).toBe(
      `[subagent job j7 interrupted]\nThe process running this job ended before it finished; full log at ${path}.\nPartial output:\nchecking the parser\nRecent tool calls:\n- mcp_lookup callers (running)`
    );
  });

  test("leaves answered spawns, live jobs and other live processes' jobs alone", async () => {
    const { emit, branch, delivered, spawn, jobs } = withJobs();
    await spawn("live");
    for (const jobId of ["answered", "live", "elsewhere", "other-host"]) {
      await writeLog(jobId, [assistant(["done"])]);
    }
    branch.push(
      spawnEntry("answered"),
      {
        type: "custom_message",
        customType: "subagent_result",
        details: { jobId: "answered" },
      },
      spawnEntry("live", { pid: process.pid, hostname: hostname() }),
      spawnEntry("elsewhere", { pid: process.ppid, hostname: hostname() }),
      spawnEntry("other-host", { pid: 2 ** 22 + 1, hostname: "not-this-host" })
    );

    await emit("session_start", { reason: "startup" });

    expect(delivered).toEqual([]);
    await jobs.stopAll(PARENT, { by: "user" });
  });

  test("a forked session leaves the jobs it copied to the session that spawned them", async () => {
    const { emit, branch, delivered } = withJobs();
    branch.push(
      spawnEntry("copied", { pid: process.pid, hostname: hostname() })
    );

    await emit("session_start", { reason: "fork" });

    expect(delivered).toEqual([]);
  });

  test("a job that reports while reconcile reads another log is recorded once", async () => {
    const { emit, branch, spawn } = withJobs();
    const session = await spawn("live");
    branch.push(
      spawnEntry("lost"),
      spawnEntry("live", { pid: process.pid, hostname: hostname() })
    );
    await writeLog("lost", [assistant(["lost answer"])]);
    await writeLog("live", [assistant(["live answer"])]);

    const reconciling = emit("agent_settled", { aborted: false });
    session.finish("live answer");
    await reconciling;
    await until(() => answers(branch, "lost") === 1, "the lost result");

    expect(answers(branch, "live")).toBe(1);
  });

  test("reconciles a lost job once, however often it runs", async () => {
    const { emit, branch, delivered } = withJobs();
    branch.push(spawnEntry("once"));
    await writeLog("once", [assistant(["done"])]);

    await Promise.all([
      emit("session_start", { reason: "startup" }),
      emit("agent_settled", { aborted: false }),
    ]);
    await until(() => delivered.length === 1, "the reconciled result");
    await Promise.resolve();

    expect(delivered).toHaveLength(1);
  });
});
