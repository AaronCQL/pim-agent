import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { SessionId } from "./Session";
import { TaskScheduler } from "./TaskScheduler";
import { TaskTool } from "./TaskTool";
import type { ScheduledTask, TaskToolInput } from "./TaskSchema";

let tmp: string;
const sessionId: SessionId = { chatId: 7, threadId: undefined };
const otherSessionId: SessionId = { chatId: 7, threadId: 99 };

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pim-task-tool-test-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function makeTool(opts?: { readonly now?: () => number }): {
  readonly run: (
    input: TaskToolInput
  ) => Promise<{ readonly text: string; readonly details: unknown }>;
  readonly scheduler: TaskScheduler;
} {
  const scheduler = new TaskScheduler({
    configDir: tmp,
    runTask: async () => {},
    now: opts?.now ?? ((): number => Date.now()),
  });
  const tool = TaskTool.build({ scheduler, sessionId });
  const run = async (
    input: TaskToolInput
  ): Promise<{ readonly text: string; readonly details: unknown }> => {
    const result = await tool.execute(
      "test-call-id",
      input,
      new AbortController().signal,
      undefined,
      // ExtensionContext stub — tool doesn't use it
      {} as never
    );
    return {
      text: result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n"),
      details: result.details,
    };
  };
  return { run, scheduler };
}

describe("task tool: create", () => {
  test("creates an interval task and returns id + nextRun", async () => {
    const t0 = Date.parse("2026-05-14T12:00:00Z");
    const { run } = makeTool({ now: () => t0 });
    const result = await run({
      action: "create",
      prompt: "drink water",
      schedule: { type: "interval", every: "1h" },
    });
    expect(result.text).toMatch(/^Created task /);
    const details = result.details as ScheduledTask;
    expect(details.prompt).toBe("drink water");
    expect(details.nextRun).toBe(new Date(t0 + 3600_000).toISOString());
  });

  test("rejects sub-minute interval", async () => {
    const { run } = makeTool();
    await expect(
      run({
        action: "create",
        prompt: "spam",
        schedule: { type: "interval", every: "10s" },
      })
    ).rejects.toThrow(/at least 1 minute/);
  });

  test("rejects invalid cron", async () => {
    const { run } = makeTool();
    await expect(
      run({
        action: "create",
        prompt: "test",
        schedule: { type: "cron", expr: "not a cron" },
      })
    ).rejects.toThrow();
  });

  test("requires prompt and schedule", async () => {
    const { run } = makeTool();
    await expect(run({ action: "create" })).rejects.toThrow(/prompt/);
    await expect(run({ action: "create", prompt: "hi" })).rejects.toThrow(
      /schedule/
    );
  });
});

describe("task tool: list/delete/pause/resume", () => {
  test("list filters to current sessionId", async () => {
    const t0 = Date.parse("2026-05-14T12:00:00Z");
    const { run, scheduler } = makeTool({ now: () => t0 });
    await run({
      action: "create",
      prompt: "mine",
      schedule: { type: "interval", every: "1h" },
    });
    await scheduler.create(otherSessionId, {
      prompt: "not mine",
      schedule: { type: "interval", every: "1h" },
    });
    const result = await run({ action: "list" });
    const details = result.details as { readonly tasks: ScheduledTask[] };
    expect(details.tasks).toHaveLength(1);
    expect(details.tasks[0]!.prompt).toBe("mine");
  });

  test("delete removes by id", async () => {
    const t0 = Date.parse("2026-05-14T12:00:00Z");
    const { run } = makeTool({ now: () => t0 });
    const created = await run({
      action: "create",
      prompt: "soon-gone",
      schedule: { type: "interval", every: "1h" },
    });
    const id = (created.details as ScheduledTask).id;
    await run({ action: "delete", id });
    const list = await run({ action: "list" });
    expect((list.details as { tasks: ScheduledTask[] }).tasks).toHaveLength(0);
  });

  test("delete refuses cross-session id", async () => {
    const t0 = Date.parse("2026-05-14T12:00:00Z");
    const { run, scheduler } = makeTool({ now: () => t0 });
    const foreign = await scheduler.create(otherSessionId, {
      prompt: "not yours",
      schedule: { type: "interval", every: "1h" },
    });
    await expect(run({ action: "delete", id: foreign.id })).rejects.toThrow(
      /no task/
    );
  });

  test("pause flips status; resume undoes it", async () => {
    const t0 = Date.parse("2026-05-14T12:00:00Z");
    const { run } = makeTool({ now: () => t0 });
    const created = await run({
      action: "create",
      prompt: "p",
      schedule: { type: "interval", every: "1h" },
    });
    const id = (created.details as ScheduledTask).id;

    const paused = await run({ action: "pause", id });
    expect((paused.details as ScheduledTask).status).toBe("paused");

    const resumed = await run({ action: "resume", id });
    expect((resumed.details as ScheduledTask).status).toBe("active");
  });
});

describe("task tool: update_prompt", () => {
  test("changes prompt text", async () => {
    const t0 = Date.parse("2026-05-14T12:00:00Z");
    const { run } = makeTool({ now: () => t0 });
    const created = await run({
      action: "create",
      prompt: "old",
      schedule: { type: "interval", every: "1h" },
    });
    const id = (created.details as ScheduledTask).id;
    const updated = await run({ action: "update_prompt", id, prompt: "new" });
    expect((updated.details as ScheduledTask).prompt).toBe("new");
  });
});
