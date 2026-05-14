import type { ThreadHandle } from "../SessionRegistry";
import { deleteTaskFile, loadAllTasks, makeTaskId, saveTask } from "./store";
import {
  parseDurationMs,
  type ScheduleSpec,
  type ScheduledTask,
} from "./schema";

export type RunTaskFn = (task: ScheduledTask) => Promise<void>;

export type SchedulerOptions = {
  readonly configDir: string;
  readonly runTask: RunTaskFn;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
};

const MISSED_TASK_WINDOW_MS = 24 * 3600_000;
const MIN_INTERVAL_MS = 60_000;

export class Scheduler {
  private readonly configDir: string;
  private readonly runTask: RunTaskFn;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private timer: Timer | undefined;
  private inflight: Promise<void> | undefined;

  public constructor(opts: SchedulerOptions) {
    this.configDir = opts.configDir;
    this.runTask = opts.runTask;
    this.pollIntervalMs = opts.pollIntervalMs ?? 10_000;
    this.now = opts.now ?? ((): number => Date.now());
  }

  public async start(): Promise<void> {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    await this.tick();
  }

  public async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.inflight) {
      await this.inflight;
    }
  }

  public async tick(): Promise<void> {
    if (this.inflight) {
      await this.inflight;
      return;
    }
    const run = this.runTick().finally(() => {
      this.inflight = undefined;
    });
    this.inflight = run;
    await run;
  }

  private async runTick(): Promise<void> {
    const all = await loadAllTasks(this.configDir);
    const now = this.now();
    const fires: Promise<void>[] = [];

    for (const task of all) {
      if (task.status !== "active") {
        continue;
      }
      const nextMs = Date.parse(task.nextRun);
      if (!Number.isFinite(nextMs) || nextMs > now) {
        continue;
      }

      if (task.expires) {
        const expMs = Date.parse(task.expires);
        if (Number.isFinite(expMs) && now > expMs) {
          await deleteTaskFile(this.configDir, task.id);
          continue;
        }
      }

      if (now - nextMs > MISSED_TASK_WINDOW_MS) {
        const advanced = Scheduler.advanceNextRun(task, now);
        if (advanced) {
          await saveTask(this.configDir, advanced);
        } else {
          await deleteTaskFile(this.configDir, task.id);
        }
        console.warn(
          `[scheduler] task ${task.id} missed by >24h, advanced silently`
        );
        continue;
      }

      fires.push(this.fireAndReschedule(task, now));
    }

    await Promise.allSettled(fires);
  }

  private async fireAndReschedule(
    task: ScheduledTask,
    firedAt: number
  ): Promise<void> {
    try {
      await this.runTask(task);
    } catch (err) {
      console.error(`[scheduler] task ${task.id} runTask failed:`, err);
    }
    const next = Scheduler.advanceNextRun(task, firedAt);
    if (next) {
      await saveTask(this.configDir, next);
    } else {
      await deleteTaskFile(this.configDir, task.id);
    }
  }

  public async listTasksFor(
    handle: ThreadHandle
  ): Promise<ReadonlyArray<ScheduledTask>> {
    const all = await loadAllTasks(this.configDir);
    return all
      .filter(
        (t) => t.chatId === handle.chatId && t.threadId === handle.threadId
      )
      .sort((a, b) => a.nextRun.localeCompare(b.nextRun));
  }

  public async findById(
    handle: ThreadHandle,
    id: string
  ): Promise<ScheduledTask | undefined> {
    const all = await this.listTasksFor(handle);
    return all.find((t) => t.id === id);
  }

  public async createTask(
    handle: ThreadHandle,
    input: {
      readonly prompt: string;
      readonly schedule: ScheduleSpec;
      readonly expires?: string;
      readonly isolatedSession?: boolean;
    }
  ): Promise<ScheduledTask> {
    const nextRun = this.computeFirstRun(input.schedule);
    if (input.expires !== undefined) {
      const expMs = Date.parse(input.expires);
      if (!Number.isFinite(expMs)) {
        throw new Error(`invalid expires timestamp: ${input.expires}`);
      }
      if (expMs <= Date.parse(nextRun)) {
        throw new Error(
          `expires must be strictly after first nextRun (${nextRun})`
        );
      }
    }
    const task: ScheduledTask = {
      id: makeTaskId(input.prompt),
      prompt: input.prompt,
      chatId: handle.chatId,
      threadId: handle.threadId,
      schedule: input.schedule,
      status: "active",
      nextRun,
      expires: input.expires ?? null,
      isolatedSession: input.isolatedSession ?? false,
      createdAt: new Date(this.now()).toISOString(),
    };
    await saveTask(this.configDir, task);
    return task;
  }

  public async deleteTaskById(
    handle: ThreadHandle,
    id: string
  ): Promise<boolean> {
    const t = await this.findById(handle, id);
    if (!t) {
      return false;
    }
    await deleteTaskFile(this.configDir, id);
    return true;
  }

  public async setStatus(
    handle: ThreadHandle,
    id: string,
    status: "active" | "paused"
  ): Promise<ScheduledTask | undefined> {
    const t = await this.findById(handle, id);
    if (!t) {
      return undefined;
    }
    if (t.status === status) {
      return t;
    }
    const updated: ScheduledTask = { ...t, status };
    await saveTask(this.configDir, updated);
    return updated;
  }

  public async updatePrompt(
    handle: ThreadHandle,
    id: string,
    prompt: string
  ): Promise<ScheduledTask | undefined> {
    const t = await this.findById(handle, id);
    if (!t) {
      return undefined;
    }
    if (t.prompt === prompt) {
      return t;
    }
    const updated: ScheduledTask = { ...t, prompt };
    await saveTask(this.configDir, updated);
    return updated;
  }

  private computeFirstRun(schedule: ScheduleSpec): string {
    const now = this.now();
    if (schedule.type === "once") {
      const at = Date.parse(schedule.at);
      if (!Number.isFinite(at)) {
        throw new Error(`invalid 'at' timestamp: ${schedule.at}`);
      }
      if (at <= now) {
        throw new Error(`'at' must be strictly in the future`);
      }
      return new Date(at).toISOString();
    }
    if (schedule.type === "interval") {
      const ms = parseDurationMs(schedule.every);
      if (ms < MIN_INTERVAL_MS) {
        throw new Error(`interval must be at least 1 minute`);
      }
      return new Date(now + ms).toISOString();
    }
    const next = Bun.cron.parse(schedule.expr, new Date(now));
    if (!next) {
      throw new Error(`cron expression has no future match: ${schedule.expr}`);
    }
    return next.toISOString();
  }

  private static advanceNextRun(
    task: ScheduledTask,
    fromMs: number
  ): ScheduledTask | undefined {
    const schedule = task.schedule;
    if (schedule.type === "once") {
      return undefined;
    }
    if (schedule.type === "interval") {
      const ms = parseDurationMs(schedule.every);
      return { ...task, nextRun: new Date(fromMs + ms).toISOString() };
    }
    const next = Bun.cron.parse(schedule.expr, new Date(fromMs));
    if (!next) {
      return undefined;
    }
    return { ...task, nextRun: next.toISOString() };
  }
}
