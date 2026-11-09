import { Format } from "../../shared/Format";
import { OutputBudget } from "../../shared/OutputBudget";
import { Timers } from "../../shared/Timers";
import { JobLine } from "./JobLine";
import { formatCallTitle } from "./render";
import { applyOutputCap, type SubagentChild } from "./subagent";
import {
  SubagentResult,
  type JobOutcome,
  type JobStop,
  type Placement,
  type StoppedBy,
  type SubagentResultMessage,
} from "./SubagentResult";

/** Plain data, so a wire protocol can carry it verbatim. */
export type JobView = {
  /** The spawning tool call's id. */
  readonly id: string;
  /** Short name in its session, `j3`. */
  readonly handle: string;
  /** The prompt's first line. */
  readonly title: string;
  /** Epoch ms. */
  readonly startedAt: number;
  readonly turns: number;
  readonly cost: number;
  readonly contextTokens?: number;
  readonly contextWindow?: number;
};

/** A finished job's result, held until it is on the parent's branch. A user stop can clear `wake` while a delivery waits, so read it when appending. */
export type JobDelivery = {
  readonly result: SubagentResultMessage;
  readonly wake: boolean;
};

/** Appends only while the parent is idle, and only a result `SubagentResult.placement` says is due right before it; a busy parent's turn boundary takes the result instead. Until it settles, it alone may append that result. Resolves to the result's placement afterwards: `due` means try again later. */
export type JobDeliverer = (delivery: JobDelivery) => Promise<Placement>;

export type JobSpec = {
  readonly callId: string;
  readonly prompt: string;
  /** The highest handle number the parent's session already holds. */
  readonly lastHandle: number;
  /** Starts the child; `onChange` fires on every state or usage change. */
  readonly start: (onChange: () => void) => SubagentChild;
};

export type JobsListener = (jobs: readonly JobView[]) => void;

type Job = {
  readonly id: string;
  readonly handle: string;
  readonly prompt: string;
  readonly startedAt: number;
  readonly child: SubagentChild;
  readonly settled: PromiseWithResolvers<SubagentResultMessage>;
  stop: JobStop | undefined;
  result: SubagentResultMessage | undefined;
};

type Pending = {
  readonly result: SubagentResultMessage;
  wake: boolean;
  delivering: boolean;
  /** A flush came while it was delivering. */
  again: boolean;
  /** Last seen with its spawn on another branch. */
  away: boolean;
};

type Parent = {
  readonly running: Map<string, Job>;
  readonly pending: Map<string, Pending>;
  readonly listeners: Set<JobsListener>;
  deliverer: JobDeliverer | undefined;
};

export type SubagentJobsOptions = {
  readonly now?: () => number;
  /** How long a stop waits for a child, and shutdown for deliveries; defaults to a few seconds. */
  readonly grace?: () => Promise<void>;
};

const PEEK_MESSAGES = 3;

function dueIn(parent: Parent): boolean {
  return parent.pending.values().some((item) => !item.away);
}

/** Background subagents for every session in the process, keyed by parent session id. */
export class SubagentJobs {
  /** The clock `JobView.startedAt` is read from. */
  public readonly now: () => number;
  private readonly parents = new Map<string, Parent>();
  private readonly grace: () => Promise<void>;
  /** Woken whenever a held result leaves. */
  private readonly drainWaiters = new Set<() => void>();

  public constructor(options: SubagentJobsOptions = {}) {
    this.now = options.now ?? Date.now;
    this.grace = options.grace ?? Timers.grace;
  }

  /** Throws when `spec.callId` is already a job of this parent, or when `start` does. */
  public spawn(parentSessionId: string, spec: JobSpec): JobView {
    if (this.has(parentSessionId, spec.callId)) {
      throw new Error(`job ${spec.callId} already exists`);
    }
    const parent = this.parentFor(parentSessionId);
    const taken = [
      spec.lastHandle,
      ...[...parent.running.values()].map((job) =>
        JobLine.handleNumber(job.handle)
      ),
      ...[...parent.pending.values()].map((item) =>
        JobLine.handleNumber(item.result.details.handle)
      ),
    ];
    const child = spec.start(() => this.emit(parentSessionId));
    const job: Job = {
      id: spec.callId,
      handle: `j${Math.max(...taken) + 1}`,
      prompt: spec.prompt,
      startedAt: this.now(),
      child,
      settled: Promise.withResolvers(),
      stop: undefined,
      result: undefined,
    };
    parent.running.set(job.id, job);
    void child.result.then(
      (result) => this.finish(parentSessionId, job, { ok: true, result }),
      (error: unknown) =>
        this.finish(parentSessionId, job, { ok: false, error })
    );
    this.emit(parentSessionId);
    return this.view(job);
  }

  /** Running jobs, oldest first. */
  public list(parentSessionId: string): readonly JobView[] {
    return this.runningJobs(parentSessionId).map((job) => this.view(job));
  }

  /** How many jobs are running, without building their views. */
  public count(parentSessionId: string): number {
    return this.parents.get(parentSessionId)?.running.size ?? 0;
  }

  public hasRunning(parentSessionId: string): boolean {
    return this.count(parentSessionId) > 0;
  }

  /** Every parent session with a job running, whichever host it belongs to. */
  public runningSessions(): readonly string[] {
    return [...this.parents]
      .filter(([, parent]) => parent.running.size > 0)
      .map(([id]) => id);
  }

  /** A finished job's result is not on the parent's branch yet. */
  public hasPending(parentSessionId: string): boolean {
    return (this.parents.get(parentSessionId)?.pending.size ?? 0) > 0;
  }

  /** A held result belongs on the parent's current branch, as far as anyone has looked. */
  public hasDue(parentSessionId: string): boolean {
    const parent = this.parents.get(parentSessionId);
    return parent !== undefined && dueIn(parent);
  }

  /** Running, or finished with its result not yet on the branch. */
  public has(parentSessionId: string, id: string): boolean {
    const parent = this.parents.get(parentSessionId);
    return (
      parent !== undefined && (parent.running.has(id) || parent.pending.has(id))
    );
  }

  public subscribe(
    parentSessionId: string,
    listener: JobsListener
  ): () => void {
    const parent = this.parentFor(parentSessionId);
    parent.listeners.add(listener);
    return () => {
      parent.listeners.delete(listener);
      this.prune(parentSessionId);
    };
  }

  /** The running job `ref` names, by handle or by id. Throws when none does. */
  public resolve(parentSessionId: string, ref: string): JobView {
    return this.view(this.find(parentSessionId, ref));
  }

  /** The job `ref` names, in detail, for the model. */
  public peek(parentSessionId: string, ref: string): string {
    return this.detail(this.find(parentSessionId, ref));
  }

  /** Stops the job `ref` names. Resolves to its result, at the latest once the grace runs out. */
  public async stop(
    parentSessionId: string,
    ref: string,
    stop: JobStop
  ): Promise<SubagentResultMessage> {
    const job = this.find(parentSessionId, ref);
    if (stop.by === "user") {
      this.silence(parentSessionId);
    }
    const [result] = await this.stopJobs(parentSessionId, [job], stop);
    return result!;
  }

  /** Resolves to how many jobs it stopped. A user stop also keeps every held result from waking the parent. */
  public async stopAll(
    parentSessionId: string,
    stop: { readonly by: StoppedBy }
  ): Promise<number> {
    if (stop.by === "user") {
      this.silence(parentSessionId);
    }
    const jobs = this.runningJobs(parentSessionId);
    await this.stopJobs(parentSessionId, jobs, stop);
    return jobs.length;
  }

  /** Stops every job and waits, until the grace runs out, for the results attached parents have due to land. */
  public async stopEverything(): Promise<void> {
    const stopped = Promise.all(
      [...this.parents.keys()].map((id) => this.stopAll(id, { by: "user" }))
    );
    await Promise.race([stopped.then(() => this.drained()), this.grace()]);
  }

  /** Resolves to the job it steered. */
  public async steer(
    parentSessionId: string,
    ref: string,
    message: string
  ): Promise<JobView> {
    const job = this.find(parentSessionId, ref);
    if (job.stop !== undefined) {
      throw new Error(
        `job ${job.handle} is being stopped and can no longer be steered`
      );
    }
    await job.child.steer(message);
    return this.view(job);
  }

  /** One deliverer per parent; attaching retries the held results. */
  public attach(parentSessionId: string, deliverer: JobDeliverer): () => void {
    const parent = this.parentFor(parentSessionId);
    parent.deliverer = deliverer;
    this.flush(parentSessionId);
    return () => {
      if (parent.deliverer === deliverer) {
        parent.deliverer = undefined;
        this.prune(parentSessionId);
        this.drainChanged();
      }
    };
  }

  /** Hands every held result to the attached deliverer; one already on its way is retried if it comes back deferred. */
  public flush(parentSessionId: string): void {
    for (const item of this.parents.get(parentSessionId)?.pending.values() ??
      []) {
      this.deliver(parentSessionId, item);
    }
  }

  /** Held results for a turn boundary to append: those `place` says are due, except one a deliverer is appending. Drops those already landed. */
  public due(
    parentSessionId: string,
    place: (jobId: string) => Placement
  ): readonly JobDelivery[] {
    const parent = this.parents.get(parentSessionId);
    const due: JobDelivery[] = [];
    for (const [jobId, item] of parent?.pending ?? []) {
      const where = place(jobId);
      this.apply(parentSessionId, jobId, item, where);
      if (where === "due" && !item.delivering) {
        due.push(item);
      }
    }
    return due;
  }

  /** Holds a result rebuilt outside the registry, unless this job is already known. Never wakes. */
  public recover(parentSessionId: string, result: SubagentResultMessage): void {
    if (this.has(parentSessionId, result.details.jobId)) {
      return;
    }
    this.hold(parentSessionId, result, false);
  }

  private deliver(parentSessionId: string, item: Pending): void {
    const parent = this.parents.get(parentSessionId);
    const jobId = item.result.details.jobId;
    const deliverer = parent?.deliverer;
    if (deliverer === undefined || parent?.pending.get(jobId) !== item) {
      return;
    }
    if (item.delivering) {
      item.again = true;
      return;
    }
    item.delivering = true;
    item.again = false;
    void (async () => {
      let where: Placement = "due";
      try {
        where = await deliverer(item);
      } catch (err) {
        console.warn(`[subagent] delivering job ${jobId} failed:`, err);
      } finally {
        item.delivering = false;
      }
      this.apply(parentSessionId, jobId, item, where);
      if (where !== "landed" && item.again) {
        this.deliver(parentSessionId, item);
      }
    })();
  }

  private find(parentSessionId: string, ref: string): Job {
    const running = this.runningJobs(parentSessionId);
    const found =
      running.find((job) => job.handle === ref) ??
      running.find((job) => job.id === ref);
    if (found === undefined) {
      throw new Error(this.unknown(parentSessionId, ref));
    }
    return found;
  }

  private silence(parentSessionId: string): void {
    for (const item of this.parents.get(parentSessionId)?.pending.values() ??
      []) {
      item.wake = false;
    }
  }

  /** Waits for each child to settle, but past the grace finishes it as stopped without it. */
  private async stopJobs(
    parentSessionId: string,
    jobs: readonly Job[],
    stop: JobStop
  ): Promise<readonly SubagentResultMessage[]> {
    if (jobs.length === 0) {
      return [];
    }
    for (const job of jobs) {
      job.stop ??= stop;
      void job.child.stop();
    }
    const abandon = this.grace().then(() =>
      jobs.map((job) =>
        this.finish(parentSessionId, job, {
          ok: false,
          error: new Error("the subagent did not stop in time"),
        })
      )
    );
    return await Promise.race([
      Promise.all(jobs.map((job) => job.settled.promise)),
      abandon,
    ]);
  }

  /** Idempotent: a child abandoned past the grace may still settle later. */
  private finish(
    parentSessionId: string,
    job: Job,
    outcome: JobOutcome
  ): SubagentResultMessage {
    if (job.result !== undefined) {
      return job.result;
    }
    const parent = this.parentFor(parentSessionId);
    parent.running.delete(job.id);
    const capture = job.child.capture;
    const result = SubagentResult.of(
      {
        jobId: job.id,
        handle: job.handle,
        prompt: job.prompt,
      },
      {
        outcome,
        details: capture.details(),
        tools: capture.recentTools(),
        stop: job.stop,
        stillRunning: [...parent.running.values()]
          .filter((other) => other.stop === undefined)
          .map((other) => other.handle),
      }
    );
    job.result = result;
    job.settled.resolve(result);
    this.hold(parentSessionId, result, job.stop === undefined);
    this.emit(parentSessionId);
    return result;
  }

  private hold(
    parentSessionId: string,
    result: SubagentResultMessage,
    wake: boolean
  ): void {
    this.parentFor(parentSessionId).pending.set(result.details.jobId, {
      result,
      wake,
      delivering: false,
      again: false,
      away: false,
    });
    this.flush(parentSessionId);
  }

  private settle(parentSessionId: string, jobId: string): void {
    if (this.parents.get(parentSessionId)?.pending.delete(jobId) === true) {
      this.prune(parentSessionId);
      this.drainChanged();
    }
  }

  /** Settles a landed result; otherwise records whether its spawn is on another branch. */
  private apply(
    parentSessionId: string,
    jobId: string,
    item: Pending,
    where: Placement
  ): void {
    if (where === "landed") {
      this.settle(parentSessionId, jobId);
      return;
    }
    const away = where === "elsewhere";
    if (item.away !== away) {
      item.away = away;
      this.drainChanged();
    }
  }

  private drainChanged(): void {
    for (const waiter of this.drainWaiters) {
      waiter();
    }
    this.drainWaiters.clear();
  }

  /** Until no parent with a deliverer has a result due. */
  private async drained(): Promise<void> {
    while (
      [...this.parents.values()].some(
        (parent) => parent.deliverer !== undefined && dueIn(parent)
      )
    ) {
      const changed = Promise.withResolvers<void>();
      this.drainWaiters.add(changed.resolve);
      await changed.promise;
    }
  }

  private emit(parentSessionId: string): void {
    const parent = this.parents.get(parentSessionId);
    if (parent === undefined || parent.listeners.size === 0) {
      return;
    }
    const jobs = this.list(parentSessionId);
    for (const listener of parent.listeners) {
      listener(jobs);
    }
  }

  private detail(job: Job): string {
    const capture = job.child.capture;
    const view = this.view(job);
    const lines = [
      `Job ${job.handle}: ${job.stop === undefined ? "running" : "stopping"} for ${Format.formatElapsed(this.now() - job.startedAt)}, ${Format.count(view.turns, "turn")}, $${view.cost.toFixed(2)}`,
      `Prompt: ${view.title}`,
      ...SubagentResult.toolLines(capture.recentTools()),
    ];
    const newestFirst = capture.messages().slice(-PEEK_MESSAGES).reverse();
    const { visible } = OutputBudget.applyByteCap(newestFirst, {
      maxBytes: OutputBudget.maxBytes / 2,
      separator: "\n\n",
    });
    if (visible.length > 0) {
      lines.push("Latest messages:", [...visible].reverse().join("\n\n"));
    }
    return applyOutputCap(lines.join("\n")).text;
  }

  private view(job: Job): JobView {
    const { usage, contextWindow } = job.child.capture.snapshot();
    return {
      id: job.id,
      handle: job.handle,
      title: formatCallTitle(job.prompt),
      startedAt: job.startedAt,
      turns: usage.turns,
      cost: usage.cost,
      ...(usage.contextTokens === undefined
        ? {}
        : { contextTokens: usage.contextTokens }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
    };
  }

  private runningJobs(parentSessionId: string): readonly Job[] {
    return [...(this.parents.get(parentSessionId)?.running.values() ?? [])];
  }

  private unknown(parentSessionId: string, ref: string): string {
    const running = this.runningJobs(parentSessionId).map((job) => job.handle);
    const hint =
      running.length === 0
        ? "No jobs are running."
        : `Running: ${running.join(", ")}.`;
    return `No running subagent job with handle or id "${ref}"; it may have finished, and its result arrives as a subagent_result message. ${hint}`;
  }

  private parentFor(parentSessionId: string): Parent {
    let parent = this.parents.get(parentSessionId);
    if (parent === undefined) {
      parent = {
        running: new Map(),
        pending: new Map(),
        listeners: new Set(),
        deliverer: undefined,
      };
      this.parents.set(parentSessionId, parent);
    }
    return parent;
  }

  private prune(parentSessionId: string): void {
    const parent = this.parents.get(parentSessionId);
    if (
      parent !== undefined &&
      parent.running.size === 0 &&
      parent.pending.size === 0 &&
      parent.listeners.size === 0 &&
      parent.deliverer === undefined
    ) {
      this.parents.delete(parentSessionId);
    }
  }
}
