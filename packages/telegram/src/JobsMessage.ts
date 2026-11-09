import type { Api } from "grammy";

import { JobLine } from "#core/extensions/subagent/JobLine";
import type { JobView } from "#core/extensions/subagent/SubagentJobs";
import { Format } from "#core/shared/Format";
import { Timers, type Every } from "#core/shared/Timers";
import { RichMessage, type EditOutcome } from "./RichMessage";
import type { SessionId } from "./Session";
import { BR } from "./TelegramHtml";

export type JobsSource = {
  readonly jobs: readonly JobView[];
  onJobsChange(listener: () => void): () => void;
};

export type JobsMessageDeps = {
  readonly api: Api;
  readonly chat: SessionId;
  readonly source: JobsSource;
  readonly now?: () => number;
  readonly every?: Every;
  /** How long `dispose` waits for the queued edits; defaults to a few seconds. */
  readonly grace?: () => Promise<void>;
};

const REFRESH_MS = 5_000;
const MAX_ROWS = 10;

function render(jobs: readonly JobView[], now: number): string {
  const rows = jobs.slice(0, MAX_ROWS).map((job) => row(job, now));
  const hidden = jobs.length - rows.length;
  return [
    `🤖 <b>${Format.count(jobs.length, "job")} running</b>`,
    ...rows,
    ...(hidden > 0 ? [`+${hidden} more`] : []),
  ].join(BR);
}

function row(job: JobView, now: number): string {
  const line = JobLine.parts(job, now);
  return `• <b>${line.handle}</b>: ${[...line.stats, line.elapsed].join(JobLine.SEPARATOR)}`;
}

/** One chat message listing the session's running jobs; it outlives the turns that spawn them. */
export class JobsMessage {
  private readonly api: Api;
  private readonly chat: SessionId;
  private readonly source: JobsSource;
  private readonly now: () => number;
  private readonly every: Every;
  private readonly grace: () => Promise<void>;
  private readonly unsubscribe: () => void;
  /** This batch's jobs, for its closing line. */
  private readonly shown = new Set<string>();
  private batch = 0;
  private messageId: number | undefined;
  private lastHtml = "";
  private stopTicking: (() => void) | undefined;
  private paintQueued = false;
  private tail: Promise<void> = Promise.resolve();

  public constructor(deps: JobsMessageDeps) {
    this.api = deps.api;
    this.chat = deps.chat;
    this.source = deps.source;
    this.now = deps.now ?? Date.now;
    this.every = deps.every ?? Timers.every;
    this.grace = deps.grace ?? Timers.grace;
    this.unsubscribe = deps.source.onJobsChange(() => this.onChange());
  }

  /** Settles once every Telegram call queued so far has. */
  public settled(): Promise<void> {
    return this.tail;
  }

  /** Stops following the jobs; settles once the edits queued so far have, or the grace runs out. */
  public dispose(): Promise<void> {
    this.unsubscribe();
    this.stopTicking?.();
    this.stopTicking = undefined;
    return Promise.race([this.tail, this.grace()]);
  }

  private onChange(): void {
    const jobs = this.source.jobs;
    for (const job of jobs) {
      this.shown.add(job.id);
    }
    const running = jobs.length > 0;
    if (running && this.stopTicking === undefined) {
      this.stopTicking = this.every(REFRESH_MS, () => this.queuePaint());
      this.queuePaint();
    } else if (!running && this.stopTicking !== undefined) {
      this.stopTicking();
      this.stopTicking = undefined;
      const ended = this.shown.size;
      this.shown.clear();
      this.batch += 1;
      this.paintQueued = false;
      this.enqueue(() => this.close(ended));
    }
  }

  private queuePaint(): void {
    if (this.paintQueued) {
      return;
    }
    this.paintQueued = true;
    const batch = this.batch;
    this.enqueue(async () => {
      if (batch === this.batch) {
        this.paintQueued = false;
        await this.paint();
      }
    });
  }

  private enqueue(step: () => Promise<void>): void {
    this.tail = this.tail.then(step).catch((err: unknown) => {
      console.warn(`[jobs] message update failed:`, err);
    });
  }

  private async paint(): Promise<void> {
    const jobs = this.source.jobs;
    if (jobs.length === 0) {
      return;
    }
    await this.show(render(jobs, this.now()));
  }

  private async close(ended: number): Promise<void> {
    const html = `🤖 ${Format.count(ended, "job")} ended`;
    if ((await this.edit(html)) === "failed") {
      await this.edit(html);
    }
    this.messageId = undefined;
    this.lastHtml = "";
  }

  private async show(html: string): Promise<void> {
    if (html === this.lastHtml) {
      return;
    }
    if ((await this.edit(html)) !== "missing") {
      return;
    }
    const sent = await RichMessage.send(this.api, this.chat, html, "jobs");
    this.messageId = sent?.message_id;
    this.lastHtml = sent === undefined ? "" : html;
  }

  /** `missing` when there is no message to edit, or Telegram lost it. */
  private async edit(html: string): Promise<EditOutcome> {
    if (this.messageId === undefined) {
      return "missing";
    }
    const outcome = await RichMessage.edit(
      this.api,
      this.chat,
      this.messageId,
      html,
      "jobs"
    );
    if (outcome === "edited") {
      this.lastHtml = html;
    }
    return outcome;
  }
}
