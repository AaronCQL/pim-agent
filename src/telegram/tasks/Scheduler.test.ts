import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ThreadHandle } from "../SessionRegistry";
import { Scheduler } from "./Scheduler";
import { loadAllTasks, saveTask, tasksDir } from "./store";
import { parseDurationMs, type ScheduledTask } from "./schema";

let tmp: string;
const handle: ThreadHandle = { chatId: 42, threadId: undefined };

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pim-scheduler-test-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function makeScheduler(opts: {
  readonly now: () => number;
  readonly onFire?: (task: ScheduledTask) => Promise<void>;
}): { readonly scheduler: Scheduler; readonly fired: ScheduledTask[] } {
  const fired: ScheduledTask[] = [];
  const scheduler = new Scheduler({
    configDir: tmp,
    runTask: async (task) => {
      fired.push(task);
      await opts.onFire?.(task);
    },
    now: opts.now,
  });
  return { scheduler, fired };
}

async function listTaskFiles(): Promise<string[]> {
  try {
    return await readdir(tasksDir(tmp));
  } catch {
    return [];
  }
}

describe("parseDurationMs", () => {
  test("parses simple units", () => {
    expect(parseDurationMs("30s")).toBe(30_000);
    expect(parseDurationMs("5m")).toBe(300_000);
    expect(parseDurationMs("2h")).toBe(7_200_000);
    expect(parseDurationMs("1d")).toBe(86_400_000);
  });

  test("parses compound durations", () => {
    expect(parseDurationMs("1h30m")).toBe(5_400_000);
    expect(parseDurationMs("2h15m30s")).toBe(8_130_000);
  });

  test("rejects garbage", () => {
    expect(() => parseDurationMs("")).toThrow();
    expect(() => parseDurationMs("forever")).toThrow();
    expect(() => parseDurationMs("10")).toThrow();
  });
});

describe("Scheduler.tick", () => {
  test("fires due active task and reschedules interval", async () => {
    const t0 = Date.parse("2026-05-14T12:00:00Z");
    const { scheduler, fired } = makeScheduler({ now: () => t0 });
    const task = await scheduler.createTask(handle, {
      prompt: "test",
      schedule: { type: "interval", every: "30m" },
    });
    expect(task.nextRun).toBe(new Date(t0 + 30 * 60_000).toISOString());

    // Not yet due
    await scheduler.tick();
    expect(fired).toHaveLength(0);

    // 30 min later, due
    const t1 = t0 + 30 * 60_000 + 5_000;
    const later = makeScheduler({ now: () => t1 });
    await later.scheduler.tick();
    expect(later.fired).toHaveLength(1);
    expect(later.fired[0]!.id).toBe(task.id);

    const reloaded = (await loadAllTasks(tmp))[0]!;
    expect(reloaded.nextRun).toBe(new Date(t1 + 30 * 60_000).toISOString());
  });

  test("skips paused tasks", async () => {
    const t0 = Date.parse("2026-05-14T12:00:00Z");
    const { scheduler } = makeScheduler({ now: () => t0 });
    const task = await scheduler.createTask(handle, {
      prompt: "test",
      schedule: { type: "interval", every: "5m" },
    });
    await scheduler.setStatus(handle, task.id, "paused");

    const t1 = t0 + 6 * 60_000;
    const { scheduler: s2, fired } = makeScheduler({ now: () => t1 });
    await s2.tick();
    expect(fired).toHaveLength(0);

    // File still exists
    expect(await listTaskFiles()).toHaveLength(1);
  });

  test("once task is deleted after firing", async () => {
    const t0 = Date.parse("2026-05-14T12:00:00Z");
    const { scheduler } = makeScheduler({ now: () => t0 });
    const at = new Date(t0 + 60_000).toISOString();
    await scheduler.createTask(handle, {
      prompt: "test",
      schedule: { type: "once", at },
    });

    const t1 = t0 + 90_000;
    const { scheduler: s2, fired } = makeScheduler({ now: () => t1 });
    await s2.tick();
    expect(fired).toHaveLength(1);
    expect(await listTaskFiles()).toHaveLength(0);
  });

  test("missed >24h is advanced silently without firing", async () => {
    const t0 = Date.parse("2026-05-14T12:00:00Z");
    // Manually write a task whose nextRun is 26h in the past
    const stale: ScheduledTask = {
      id: "stale-task",
      prompt: "test",
      chatId: handle.chatId,
      threadId: handle.threadId,
      schedule: { type: "interval", every: "1h" },
      status: "active",
      nextRun: new Date(t0 - 26 * 3600_000).toISOString(),
      expires: null,
      isolatedSession: false,
      createdAt: new Date(t0 - 30 * 3600_000).toISOString(),
    };
    await saveTask(tmp, stale);

    const { scheduler, fired } = makeScheduler({ now: () => t0 });
    await scheduler.tick();
    expect(fired).toHaveLength(0);

    const reloaded = (await loadAllTasks(tmp))[0]!;
    expect(Date.parse(reloaded.nextRun)).toBeGreaterThan(t0);
  });

  test("missed <24h fires once", async () => {
    const t0 = Date.parse("2026-05-14T12:00:00Z");
    const stale: ScheduledTask = {
      id: "recent-miss",
      prompt: "test",
      chatId: handle.chatId,
      threadId: handle.threadId,
      schedule: { type: "interval", every: "1h" },
      status: "active",
      nextRun: new Date(t0 - 2 * 3600_000).toISOString(),
      expires: null,
      isolatedSession: false,
      createdAt: new Date(t0 - 5 * 3600_000).toISOString(),
    };
    await saveTask(tmp, stale);

    const { scheduler, fired } = makeScheduler({ now: () => t0 });
    await scheduler.tick();
    expect(fired).toHaveLength(1);
  });

  test("expired task is deleted without firing", async () => {
    const t0 = Date.parse("2026-05-14T12:00:00Z");
    const expired: ScheduledTask = {
      id: "expired",
      prompt: "test",
      chatId: handle.chatId,
      threadId: handle.threadId,
      schedule: { type: "interval", every: "1h" },
      status: "active",
      nextRun: new Date(t0 - 60_000).toISOString(),
      expires: new Date(t0 - 30_000).toISOString(),
      isolatedSession: false,
      createdAt: new Date(t0 - 2 * 3600_000).toISOString(),
    };
    await saveTask(tmp, expired);

    const { scheduler, fired } = makeScheduler({ now: () => t0 });
    await scheduler.tick();
    expect(fired).toHaveLength(0);
    expect(await listTaskFiles()).toHaveLength(0);
  });

  test("cron task next-run advances via Bun.cron.parse", async () => {
    const t0 = Date.parse("2026-05-14T12:00:00Z");
    const { scheduler } = makeScheduler({ now: () => t0 });
    const task = await scheduler.createTask(handle, {
      prompt: "test",
      schedule: { type: "cron", expr: "0 * * * *" },
    });
    expect(task.nextRun).toBe(new Date(t0 + 3600_000).toISOString());

    // Fire it
    const fireTime = t0 + 3600_000 + 30_000;
    const { scheduler: s2, fired } = makeScheduler({ now: () => fireTime });
    await s2.tick();
    expect(fired).toHaveLength(1);

    const reloaded = (await loadAllTasks(tmp))[0]!;
    // Should advance to next top-of-hour after firing
    expect(Date.parse(reloaded.nextRun)).toBeGreaterThan(fireTime);
  });
});

describe("Scheduler create validation", () => {
  test("rejects 'once' with past timestamp", async () => {
    const t0 = Date.parse("2026-05-14T12:00:00Z");
    const { scheduler } = makeScheduler({ now: () => t0 });
    await expect(
      scheduler.createTask(handle, {
        prompt: "test",
        schedule: { type: "once", at: new Date(t0 - 1000).toISOString() },
      })
    ).rejects.toThrow();
  });

  test("rejects sub-minute interval", async () => {
    const t0 = Date.parse("2026-05-14T12:00:00Z");
    const { scheduler } = makeScheduler({ now: () => t0 });
    await expect(
      scheduler.createTask(handle, {
        prompt: "test",
        schedule: { type: "interval", every: "30s" },
      })
    ).rejects.toThrow();
  });

  test("rejects expires before first nextRun", async () => {
    const t0 = Date.parse("2026-05-14T12:00:00Z");
    const { scheduler } = makeScheduler({ now: () => t0 });
    await expect(
      scheduler.createTask(handle, {
        prompt: "test",
        schedule: { type: "interval", every: "1h" },
        expires: new Date(t0 + 5 * 60_000).toISOString(),
      })
    ).rejects.toThrow();
  });
});

describe("Scheduler listTasksFor", () => {
  test("filters by chat/thread", async () => {
    const t0 = Date.parse("2026-05-14T12:00:00Z");
    const { scheduler } = makeScheduler({ now: () => t0 });
    await scheduler.createTask(
      { chatId: 1, threadId: undefined },
      { prompt: "a", schedule: { type: "interval", every: "1h" } }
    );
    await scheduler.createTask(
      { chatId: 1, threadId: 99 },
      { prompt: "b", schedule: { type: "interval", every: "1h" } }
    );
    await scheduler.createTask(
      { chatId: 2, threadId: undefined },
      { prompt: "c", schedule: { type: "interval", every: "1h" } }
    );

    const main = await scheduler.listTasksFor({
      chatId: 1,
      threadId: undefined,
    });
    expect(main).toHaveLength(1);
    expect(main[0]!.prompt).toBe("a");

    const threaded = await scheduler.listTasksFor({ chatId: 1, threadId: 99 });
    expect(threaded).toHaveLength(1);
    expect(threaded[0]!.prompt).toBe("b");
  });
});
