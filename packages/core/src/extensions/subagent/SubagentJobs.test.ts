import { describe, expect, spyOn, test } from "bun:test";

import { until } from "../../shared/fixtures/wait";
import {
  assistant,
  FakeSession,
  HeldSession,
  parent,
  usage,
} from "./fixtures/session";
import { startSubagent, type SubagentParent } from "./subagent";
import {
  SubagentJobs,
  type JobDelivery,
  type JobView,
  type SubagentJobsOptions,
} from "./SubagentJobs";
import type { JobMessage, Placement } from "./JobMessage";
import type { SubagentResultMessage } from "./SubagentResult";

const PARENT = "parent-1";

type Delivery = {
  readonly result: SubagentResultMessage;
  readonly wake: boolean;
};

function setup(options: SubagentJobsOptions = { now: () => 1_000 }) {
  const jobs = new SubagentJobs(options);
  const deliveries: Delivery[] = [];
  let outcome: Placement = "landed";

  const spawn = (
    callId: string,
    spec: {
      readonly lastHandle?: number;
      readonly session?: FakeSession;
      readonly parentId?: string;
      readonly parent?: SubagentParent;
    } = {}
  ): FakeSession => {
    const session = spec.session ?? new HeldSession();
    jobs.spawn(spec.parentId ?? PARENT, {
      callId,
      prompt: `task ${callId}\nwith details`,
      lastHandle: spec.lastHandle ?? 0,
      start: (onChange) =>
        startSubagent(callId, spec.parent ?? parent, {
          createSession: async () => session,
          onChange,
        }),
    });
    return session;
  };

  const held = async (
    callId: string,
    spec: { readonly lastHandle?: number } = {}
  ): Promise<HeldSession> => {
    const session = spawn(callId, spec) as HeldSession;
    await until(() => session.promptCalls === 1, "the child to be prompted");
    return session;
  };

  const attach = (): (() => void) =>
    jobs.attach(PARENT, async ({ message, wake }) => {
      if (outcome === "landed") {
        deliveries.push({ result: message as SubagentResultMessage, wake });
      }
      return outcome;
    });

  const defer = (deferring: boolean): void => {
    outcome = deferring ? "due" : "landed";
  };

  return { jobs, deliveries, spawn, held, attach, defer };
}

describe("SubagentJobs", () => {
  test("lists a spawned job as plain data until it finishes", async () => {
    const { jobs, held } = setup();
    const seen: (readonly JobView[])[] = [];
    jobs.subscribe(PARENT, (list) => seen.push(list));

    const session = await held("call-1");

    expect(jobs.list(PARENT)).toEqual([
      {
        id: "call-1",
        handle: "j1",
        title: "task call-1",
        startedAt: 1_000,
        turns: 0,
        cost: 0,
      },
    ]);
    expect(jobs.hasRunning(PARENT)).toBe(true);
    expect(jobs.list("another-parent")).toEqual([]);

    session.finish("all good", 0.25);
    await until(() => !jobs.hasRunning(PARENT), "the job to finish");

    expect(jobs.list(PARENT)).toEqual([]);
    expect(seen.at(-1)).toEqual([]);
    expect(seen.some((list) => list[0]?.cost === 0.25)).toBe(true);
  });

  test("lists a job's context once the child reports its usage", async () => {
    const { jobs, spawn } = setup();
    const session = spawn("call-1", {
      parent: {
        ...parent,
        model: { id: "m", contextWindow: 200_000 } as never,
      },
    });
    await until(() => session.promptCalls === 1, "the child to be prompted");
    session.emit({
      type: "message_end",
      message: assistant(["Reading."], {
        stopReason: "toolUse",
        usage: usage({ totalTokens: 10_000 }),
      }),
    });

    expect(jobs.list(PARENT)[0]).toMatchObject({
      contextTokens: 10_000,
      contextWindow: 200_000,
    });
    await jobs.stopAll(PARENT, { by: "user" });
  });

  test("hands out the next handle above the session's and every known job's", async () => {
    const { jobs, held } = setup();

    const first = await held("call-1", { lastHandle: 4 });
    await held("call-2", { lastHandle: 2 });
    first.finish("done");
    await until(() => jobs.list(PARENT).length === 1, "the first job to end");
    await held("call-3");

    expect(jobs.hasPending(PARENT)).toBe(true);
    expect(jobs.list(PARENT).map((job) => job.handle)).toEqual(["j6", "j7"]);
    await jobs.stopAll(PARENT, { by: "user" });
  });

  test("delivers exactly one waking result per finished job, naming the jobs still running", async () => {
    const { jobs, deliveries, held, attach } = setup();
    attach();

    const session = await held("call-1");
    await held("call-2");
    session.finish("the answer");
    await until(() => deliveries.length === 1, "the delivery");
    await jobs.stopAll(PARENT, { by: "user" });

    expect(deliveries).toHaveLength(2);
    const [{ result, wake }] = deliveries as [Delivery];
    expect(wake).toBe(true);
    expect(result.customType).toBe("subagent_result");
    expect(result.display).toBe(true);
    expect(result.content).toBe(
      "[subagent job j1 done]\nthe answer\n\nStill running: j2."
    );
    expect(result.details).toMatchObject({
      jobId: "call-1",
      handle: "j1",
      prompt: "task call-1\nwith details",
      state: "done",
      returnedOutput: "the answer",
    });
    expect(deliveries[1]?.result.content).toEndWith("No other jobs running.");
    expect(jobs.has(PARENT, "call-1")).toBe(false);
  });

  test("a failed child still wakes its parent, with the failure", async () => {
    const { deliveries, held, attach } = setup();
    attach();

    const session = await held("call-1");
    session.fail("provider exploded");
    await until(() => deliveries.length === 1, "the delivery");

    expect(deliveries[0]?.wake).toBe(true);
    expect(deliveries[0]?.result.details.state).toBe("failed");
    expect(deliveries[0]?.result.content).toContain(
      "[subagent job j1 failed]\nSubagent failed: error. Error: provider exploded."
    );
  });

  test("holds results until a deliverer attaches, then flushes them once", async () => {
    const { jobs, deliveries, held, attach } = setup();

    const session = await held("call-1");
    session.finish("early");
    await until(() => !jobs.hasRunning(PARENT), "the job to finish");

    expect(jobs.hasPending(PARENT)).toBe(true);
    expect(deliveries).toEqual([]);

    const detach = attach();
    await until(() => deliveries.length === 1, "the flushed delivery");
    detach();
    attach();
    await Promise.resolve();

    expect(deliveries).toHaveLength(1);
    expect(jobs.has(PARENT, "call-1")).toBe(false);
  });

  test("a detached deliverer gets nothing more, and an older detach leaves a newer one", async () => {
    const { jobs, deliveries, held, attach } = setup();
    const detachOld = attach();
    const later: SubagentResultMessage[] = [];
    jobs.attach(PARENT, async ({ message }) => {
      later.push(message as SubagentResultMessage);
      return "landed";
    });
    detachOld();

    const session = await held("call-1");
    session.finish("done");
    await until(() => later.length === 1, "the newer deliverer");

    expect(deliveries).toEqual([]);
  });

  test("a deferred result is held until a flush finds the parent ready", async () => {
    const { jobs, deliveries, held, attach, defer } = setup();
    defer(true);
    attach();

    const session = await held("call-1");
    session.finish("done");
    await until(() => !jobs.hasRunning(PARENT), "the job to finish");
    await Promise.resolve();

    expect(jobs.hasPending(PARENT)).toBe(true);
    defer(false);
    jobs.flush(PARENT);
    await until(() => deliveries.length === 1, "the retried delivery");
    expect(jobs.hasPending(PARENT)).toBe(false);
  });

  test("a flush while a delivery is out retries it if it comes back deferred", async () => {
    const { jobs, held } = setup();
    const attempts: PromiseWithResolvers<Placement>[] = [];
    jobs.attach(PARENT, () => {
      const attempt = Promise.withResolvers<Placement>();
      attempts.push(attempt);
      return attempt.promise;
    });
    const session = await held("call-1");
    session.finish("done");
    await until(() => attempts.length === 1, "the first try");

    jobs.flush(PARENT);
    jobs.flush(PARENT);
    expect(attempts).toHaveLength(1);
    attempts[0]!.resolve("due");
    await until(() => attempts.length === 2, "the retry");
    attempts[1]!.resolve("landed");
    await until(() => !jobs.hasPending(PARENT), "the result to settle");

    expect(attempts).toHaveLength(2);
  });

  test("a failed delivery is warned about and held for the next try", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const { jobs, held } = setup();
    let attempts = 0;
    jobs.attach(PARENT, async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("agent gone");
      }
      return "landed";
    });

    const session = await held("call-1");
    session.finish("done");
    await until(() => warn.mock.calls.length === 1, "the warning");
    expect(jobs.has(PARENT, "call-1")).toBe(true);

    jobs.flush(PARENT);
    await until(() => !jobs.has(PARENT, "call-1"), "the second try");
    expect(attempts).toBe(2);
    expect(warn.mock.calls.flat().join(" ")).toContain("call-1");
    warn.mockRestore();
  });

  test("a turn boundary takes the results not yet on the branch and drops those that are", async () => {
    const { jobs, held, defer, attach } = setup();
    defer(true);
    attach();
    const a = await held("a");
    const b = await held("b");
    a.finish("first");
    b.finish("second");
    await until(() => !jobs.hasRunning(PARENT), "both jobs to finish");

    const due = jobs.due(PARENT, (message) =>
      message.details.jobId === "a" ? "landed" : "due"
    );

    expect(due.map((d) => [d.message.details.jobId, d.wake])).toEqual([
      ["b", true],
    ]);
    expect(jobs.has(PARENT, "a")).toBe(false);
    expect(jobs.has(PARENT, "b")).toBe(true);
  });

  test("a turn boundary leaves a result whose spawn is on another branch, and one a deliverer is appending", async () => {
    const { jobs, held } = setup();
    const appending = Promise.withResolvers<Placement>();
    jobs.attach(PARENT, async ({ message }) =>
      message.details.jobId === "busy" ? await appending.promise : "due"
    );
    for (const id of ["busy", "away", "free"]) {
      (await held(id)).finish(id);
    }
    await until(() => !jobs.hasRunning(PARENT), "the jobs to finish");
    const place = (message: JobMessage) =>
      message.details.jobId === "away" ? "elsewhere" : "due";

    expect(jobs.due(PARENT, place).map((d) => d.message.details.jobId)).toEqual(
      ["free"]
    );

    appending.resolve("due");
    await until(
      () => jobs.due(PARENT, place).length === 2,
      "the deliverer to let go"
    );
    expect(jobs.has(PARENT, "away")).toBe(true);
  });

  test("a user stop keeps every held result from waking the parent; an agent stop does not", async () => {
    const { jobs, held, defer, attach } = setup();
    defer(true);
    attach();
    const early = await held("early");
    early.finish("before the stop");
    await until(() => !jobs.hasRunning(PARENT), "the job to finish");

    await held("late");
    await jobs.stop(PARENT, "late", { by: "agent" });
    expect(jobs.due(PARENT, () => "due").map((d) => d.wake)).toEqual([
      true,
      false,
    ]);

    await jobs.stopAll(PARENT, { by: "user" });
    expect(jobs.due(PARENT, () => "due").map((d) => d.wake)).toEqual([
      false,
      false,
    ]);
  });

  test("stop by handle resolves to the partial result with its tool work, delivered without waking", async () => {
    const { jobs, deliveries, held, attach } = setup();
    attach();
    const session = await held("call-1");
    session.emit({
      type: "message_end",
      message: assistant(["halfway"], { stopReason: "toolUse" }),
    });
    session.emit({
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "mcp_lookup",
      args: { query: "callers" },
    });

    const result = await jobs.stop(PARENT, "j1", {
      by: "agent",
      reason: "no longer needed",
    });

    expect(session.abortCalls).toBe(1);
    expect(result.details).toMatchObject({
      state: "stopped",
      stoppedBy: "agent",
      reason: "no longer needed",
    });
    expect(result.content).toBe(
      [
        "[subagent job j1 stopped by agent: no longer needed]",
        "Partial output:",
        "halfway",
        "Recent tool calls:",
        "- mcp_lookup callers (running)",
        "",
        "No other jobs running.",
      ].join("\n")
    );
    await until(() => deliveries.length === 1, "the delivery");
    expect(deliveries[0]).toEqual({ result, wake: false });
    expect(jobs.hasRunning(PARENT)).toBe(false);
  });

  test("a stop past the grace finishes a child that ignores it, as stopped", async () => {
    const grace = Promise.withResolvers<void>();
    const { jobs, spawn } = setup({ grace: () => grace.promise });
    const stubborn = new FakeSession(() => new Promise(() => {}));
    spawn("call-1", { session: stubborn });
    await until(() => stubborn.promptCalls === 1, "the child to be prompted");

    const stopping = jobs.stopAll(PARENT, { by: "user" });
    await until(() => stubborn.abortCalls === 1, "the stop");
    expect(jobs.hasRunning(PARENT)).toBe(true);
    grace.resolve();

    expect(await stopping).toBe(1);
    expect(jobs.hasRunning(PARENT)).toBe(false);
    const [held] = jobs.due(PARENT, () => "due");
    expect(held?.message.details).toMatchObject({
      state: "stopped",
      stoppedBy: "user",
    });
    expect(held?.message.content).toContain("(no text output yet)");
  });

  test("resolves a handle, else an id, to the one running job it names", async () => {
    const { jobs, held } = setup();
    await held("j2");
    await held("call-b");

    expect(jobs.resolve(PARENT, "j2").id).toBe("call-b");
    expect(jobs.resolve(PARENT, "j1").id).toBe("j2");
    expect(jobs.resolve(PARENT, "call-b").handle).toBe("j2");
    expect(() => jobs.resolve(PARENT, "nope")).toThrow(
      'No running subagent job with handle or id "nope"; it may have finished, and its result arrives as a subagent_result message. Running: j1, j2.'
    );
    await jobs.stopAll(PARENT, { by: "user" });
    expect(() => jobs.resolve(PARENT, "j1")).toThrow("No jobs are running.");
  });

  test("stop stops only the job it names, and its result lists the rest", async () => {
    const { jobs, held } = setup();
    await held("a");
    const b = await held("b");

    const result = await jobs.stop(PARENT, "j1", { by: "agent" });

    expect(result.details.jobId).toBe("a");
    expect(result.content.split("\n").at(-1)).toBe("Still running: j2.");
    expect(jobs.list(PARENT).map((job) => job.id)).toEqual(["b"]);
    b.finish("done");
  });

  test("stopAll stops every job as the user's and counts them", async () => {
    const { jobs, deliveries, held, attach } = setup();
    attach();
    await held("a");
    await held("b");

    expect(await jobs.stopAll(PARENT, { by: "user" })).toBe(2);
    expect(await jobs.stopAll(PARENT, { by: "user" })).toBe(0);

    await until(() => deliveries.length === 2, "both deliveries");
    expect(deliveries.map((d) => [d.result.details.stoppedBy, d.wake])).toEqual(
      [
        ["user", false],
        ["user", false],
      ]
    );
  });

  test("a stop racing the child's last message yields one result, without waking", async () => {
    const { jobs, deliveries, held, attach } = setup();
    attach();
    const session = await held("call-1");

    session.finish("made it");
    const result = await jobs.stop(PARENT, "call-1", { by: "user" });

    expect(result.details.state).toBe("stopped");
    expect(result.content).toContain("Partial output:\nmade it");
    await until(() => deliveries.length === 1, "the delivery");
    await Promise.resolve();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.wake).toBe(false);
  });

  test("stopEverything reaches every parent", async () => {
    const { jobs, held, spawn } = setup();
    await held("a");
    const other = spawn("z", { parentId: "parent-2" });
    await until(() => other.promptCalls === 1, "the other child");

    await jobs.stopEverything();

    expect(jobs.hasRunning(PARENT)).toBe(false);
    expect(jobs.hasRunning("parent-2")).toBe(false);
  });

  test("stopEverything resolves only once the stopped results are delivered", async () => {
    const { jobs, held } = setup();
    const landed = Promise.withResolvers<void>();
    const delivered: string[] = [];
    jobs.attach(PARENT, async ({ message }) => {
      await landed.promise;
      delivered.push(message.details.jobId);
      return "landed";
    });
    await held("call-1");
    let stoppedEverything = false;

    const stopping = jobs.stopEverything().then(() => {
      stoppedEverything = true;
    });
    await until(() => !jobs.hasRunning(PARENT), "the job to stop");

    expect(stoppedEverything).toBe(false);
    landed.resolve();
    await stopping;
    expect(delivered).toEqual(["call-1"]);
  });

  test("a result held for another branch is not due: stopEverything does not wait for it, and it lands once its branch is back", async () => {
    const { jobs, held } = setup({ grace: () => new Promise(() => {}) });
    let outcome: Placement = "elsewhere";
    jobs.attach(PARENT, async () => outcome);
    (await held("call-1")).finish("done");
    await until(() => !jobs.hasDue(PARENT), "the result to be placed");

    await jobs.stopEverything();
    expect(jobs.hasPending(PARENT)).toBe(true);

    expect(jobs.due(PARENT, () => "due")).toHaveLength(1);
    expect(jobs.hasDue(PARENT)).toBe(true);
    outcome = "landed";
    jobs.flush(PARENT);
    await until(() => !jobs.hasPending(PARENT), "the result to land");
  });

  test("stopEverything gives up on a stubborn child and a stuck delivery once its grace runs out", async () => {
    const grace = Promise.withResolvers<void>();
    const { jobs, spawn } = setup({ grace: () => grace.promise });
    const stubborn = new FakeSession(() => new Promise(() => {}));
    jobs.attach(PARENT, () => new Promise(() => {}));
    spawn("stubborn", { session: stubborn });
    const finishing = spawn("finishing");
    await until(
      () => stubborn.promptCalls === 1 && finishing.promptCalls === 1,
      "both children"
    );

    const stopping = jobs.stopEverything();
    await until(() => stubborn.abortCalls === 1, "the stubborn child's stop");
    await until(
      () => !jobs.list(PARENT).some((job) => job.id === "finishing"),
      "the other job to stop"
    );
    grace.resolve();
    await stopping;

    expect(jobs.hasRunning(PARENT)).toBe(false);
    expect(jobs.has(PARENT, "finishing")).toBe(true);
    expect(jobs.has(PARENT, "stubborn")).toBe(true);
  });

  test("steers a running job by handle and refuses one that is gone", async () => {
    const { jobs, held } = setup();
    const session = await held("call-1");

    expect((await jobs.steer(PARENT, "j1", "look at the tests too")).id).toBe(
      "call-1"
    );
    expect(session.steered).toEqual(["look at the tests too"]);

    session.finish("done");
    await until(() => !jobs.hasRunning(PARENT), "the job to finish");
    await expect(jobs.steer(PARENT, "j1", "late")).rejects.toThrow(
      "No running subagent job"
    );
  });

  test("peeks at a job's elapsed time, tools and latest messages", async () => {
    const clock = { now: 1_000 };
    const { jobs, held } = setup({ now: () => clock.now });
    const session = await held("call-1");
    session.emit({
      type: "message_end",
      message: assistant(["Reading first."], { stopReason: "toolUse" }),
    });
    session.emit({
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "mcp_lookup",
      args: { query: "callers" },
    });
    clock.now = 1_000 + 125_000;

    expect(jobs.peek(PARENT, "j1")).toBe(
      [
        "Job j1: running for 2m 5s, 1 turn, $0.00",
        "Prompt: task call-1",
        "Recent tool calls:",
        "- mcp_lookup callers (running)",
        "Latest messages:",
        "Reading first.",
      ].join("\n")
    );
    expect(() => jobs.peek(PARENT, "nope")).toThrow("No running subagent job");
    session.finish("done");
  });

  test("refuses a second job with the same id", async () => {
    const { held, spawn } = setup();
    await held("call-1");

    expect(() => spawn("call-1")).toThrow("job call-1 already exists");
  });

  test("recovers a rebuilt result once, never over a known job, never waking", async () => {
    const { jobs, deliveries, held, attach } = setup();
    const session = await held("live");
    const rebuilt = (jobId: string): SubagentResultMessage => ({
      customType: "subagent_result",
      content: `[subagent job ${jobId} interrupted]`,
      display: true,
      details: { jobId, prompt: "p", state: "interrupted" } as never,
    });

    jobs.recover(PARENT, rebuilt("live"));
    jobs.recover(PARENT, rebuilt("lost"));
    jobs.recover(PARENT, rebuilt("lost"));
    attach();
    await until(() => deliveries.length === 1, "the recovered delivery");

    expect(deliveries[0]?.result.details.jobId).toBe("lost");
    expect(deliveries[0]?.wake).toBe(false);
    session.finish("done");
    await until(() => deliveries.length === 2, "the live job's delivery");
    expect(deliveries[1]?.result.details.state).toBe("done");
  });
});

describe("SubagentJobs context notice", () => {
  const sized: SubagentParent = {
    ...parent,
    model: { contextWindow: 1_000_000 } as never,
  };

  function reach(session: FakeSession, totalTokens: number): void {
    session.emit({
      type: "message_end",
      message: assistant(["Working."], {
        stopReason: "toolUse",
        usage: usage({ totalTokens, cost: { total: 2.5 } }),
      }),
    });
  }

  function tool(session: FakeSession, id: string, path: string): void {
    session.emit({
      type: "tool_execution_start",
      toolCallId: id,
      toolName: "mcp_read",
      args: { path },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: id,
      toolName: "mcp_read",
      result: {},
      isError: false,
    });
  }

  function noticing(options: SubagentJobsOptions = { now: () => 1_000 }) {
    const harness = setup(options);
    const delivered: JobDelivery[] = [];
    let outcome: Placement = "landed";
    harness.jobs.attach(PARENT, async (delivery) => {
      delivered.push(delivery);
      return outcome;
    });
    const start = async (model = sized): Promise<HeldSession> => {
      const session = harness.spawn("call-1", { parent: model }) as HeldSession;
      await until(() => session.promptCalls === 1, "the child to be prompted");
      return session;
    };
    const defer = (deferring: boolean): void => {
      outcome = deferring ? "due" : "landed";
    };
    const notices = () =>
      delivered.filter(
        (delivery) => delivery.message.customType === "subagent_notice"
      );
    return { ...harness, delivered, notices, start, defer };
  }

  test("tells the parent once, waking it, when the context first reaches the threshold", async () => {
    let clock = 1_000;
    const { jobs, notices, start } = noticing({ now: () => clock });
    const session = await start();
    for (const [index, path] of ["a", "b", "c", "d"].entries()) {
      tool(session, `t${index}`, path);
    }
    clock += 30 * 60_000;
    reach(session, 399_999);
    expect(notices()).toEqual([]);
    expect(jobs.list(PARENT)[0]?.noticed).toBeUndefined();

    reach(session, 1);
    reach(session, 402_000);
    await until(() => notices().length === 1, "the notice");

    const [{ message, wake }] = notices() as [JobDelivery];
    expect(wake).toBe(true);
    expect(message).toEqual({
      customType: "subagent_notice",
      display: true,
      content: [
        "[subagent job j1 at 40% context, still running]",
        "3 turns · $7.50 · 40.2%/1.0M · 30m 0s",
        "Recent tool calls:",
        "- mcp_read b (done)",
        "- mcp_read c (done)",
        "- mcp_read d (done)",
        "Your call: let it finish, steer it to wrap up, or steer it to hand off (tell it to commit work in progress and report what's done, what's left, its decisions and anything failing). Doing nothing is fine.",
      ].join("\n"),
      details: {
        jobId: "call-1",
        handle: "j1",
        contextTokens: 402_000,
        contextWindow: 1_000_000,
        turns: 3,
        elapsedMs: 30 * 60_000,
        cost: 7.5,
        tools: [
          { title: "mcp_read b", state: "done" },
          { title: "mcp_read c", state: "done" },
          { title: "mcp_read d", state: "done" },
        ],
      },
    });
    expect(jobs.hasRunning(PARENT)).toBe(true);
    expect(jobs.list(PARENT).map((job) => [job.handle, job.noticed])).toEqual([
      ["j1", true],
    ]);
    await jobs.stopAll(PARENT, { by: "user" });
  });

  test("never tells it twice, even once the first notice has landed", async () => {
    const { jobs, notices, start } = noticing();
    const session = await start();
    reach(session, 400_000);
    await until(() => !jobs.hasPending(PARENT), "the notice to land");

    reach(session, 600_000);
    reach(session, 950_000);
    session.finish("done");
    await until(() => !jobs.hasRunning(PARENT), "the job to finish");
    await until(() => !jobs.hasPending(PARENT), "the result to land");

    expect(notices()).toHaveLength(1);
  });

  test("says nothing while the context window is unknown", async () => {
    const { jobs, delivered, start } = noticing();
    const session = await start(parent);
    reach(session, 5_000_000);
    session.finish("done");
    await until(() => !jobs.hasRunning(PARENT), "the job to finish");
    await until(() => !jobs.hasPending(PARENT), "the result to land");

    expect(delivered.map((d) => d.message.customType)).toEqual([
      "subagent_result",
    ]);
  });

  test("a job that finishes before its notice is delivered drops it for its result", async () => {
    const { jobs, delivered, defer, start } = noticing();
    defer(true);
    const session = await start();
    reach(session, 500_000);
    await until(() => delivered.length === 1, "the notice's delivery");
    const empty = { getBranch: () => [], getEntries: () => [] };
    expect(delivered[0]?.due(empty)).toBe(true);

    session.finish("done");
    await until(() => !jobs.hasRunning(PARENT), "the job to finish");

    expect(delivered[0]?.due(empty)).toBe(false);
    expect(
      jobs.due(PARENT, () => "due").map((d) => d.message.customType)
    ).toEqual(["subagent_result"]);
  });

  test("a job being stopped says nothing", async () => {
    const grace = Promise.withResolvers<void>();
    const { jobs, notices, spawn } = noticing({ grace: () => grace.promise });
    const stubborn = new FakeSession(() => new Promise(() => {}));
    spawn("call-1", { session: stubborn, parent: sized });
    await until(() => stubborn.promptCalls === 1, "the child to be prompted");

    const stopping = jobs.stop(PARENT, "j1", { by: "agent", reason: "done" });
    await until(() => stubborn.abortCalls === 1, "the stop");
    reach(stubborn, 500_000);
    expect(jobs.list(PARENT)[0]?.noticed).toBeUndefined();
    grace.resolve();
    await stopping;

    expect(notices()).toEqual([]);
  });
});
