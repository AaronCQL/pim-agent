import { Format } from "../../shared/Format";
import type { JobView } from "./SubagentJobs";

/** One running job as single-line display parts; every surface paints these. */
export type JobLineParts = {
  readonly handle: string;
  /** As `JobLine.usage`. */
  readonly stats: readonly string[];
  /** Since the job started, e.g. `2m 5s`. */
  readonly elapsed: string;
};

export type JobUsage = {
  readonly turns: number;
  readonly cost: number;
  readonly contextTokens?: number | undefined;
  readonly contextWindow?: number | undefined;
};

const HANDLE = /^j(\d+)$/u;
/** Between a job row's stats, on every surface. */
const SEPARATOR = " ⬝ ";

/** `j3` → 3; anything else → 0. */
function handleNumber(handle: string): number {
  return Number(HANDLE.exec(handle)?.[1] ?? 0);
}

function oneLine(text: string): string {
  return text
    .replace(/\s+/gu, " ")
    .replace(/\p{Cc}/gu, "")
    .trim();
}

/** The share of its context window the job fills, when both are known. */
function share(usage: JobUsage): number | undefined {
  const { contextTokens, contextWindow } = usage;
  return contextWindow === undefined ||
    contextWindow <= 0 ||
    contextTokens === undefined
    ? undefined
    : contextTokens / contextWindow;
}

function context(usage: JobUsage, noticed: boolean): readonly string[] {
  const filled = share(usage);
  return filled === undefined
    ? []
    : [
        `${noticed ? "⚠ " : ""}${(filled * 100).toFixed(1)}%/${Format.formatTokens(usage.contextWindow!)}`,
      ];
}

/** `4 turns`, `$0.12`, then `5.0%/1.0M` when the context is known, as `⚠ 41.0%/1.0M` once its notice was issued. */
function usage(job: JobUsage, noticed = false): readonly string[] {
  return [
    Format.count(job.turns, "turn"),
    `$${job.cost.toFixed(2)}`,
    ...context(job, noticed),
  ];
}

function parts(job: JobView, now: number): JobLineParts {
  return {
    handle: job.handle,
    stats: usage(job, job.noticed === true),
    elapsed: Format.formatElapsed(now - job.startedAt),
  };
}

/** The model's line for a running job. */
function text(job: JobView, now: number): string {
  return [
    `- ${job.handle}`,
    Format.formatElapsed(now - job.startedAt),
    ...usage(job),
    oneLine(job.title),
  ].join(" · ");
}

export const JobLine = { SEPARATOR, share, parts, usage, text, handleNumber };
