import { Format, type ContextFill } from "../../shared/Format";
import type { Span, Tone } from "../../view/ViewBlock";
import type { JobView } from "./SubagentJobs";

/** One running job as single-line display parts; every surface paints these. */
export type JobLineParts = {
  readonly handle: string;
  /** As `JobLine.usage`. */
  readonly stats: readonly Span[];
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
const FILL_TONES = {
  ok: undefined,
  warn: "warning",
  full: "error",
} as const satisfies Record<ContextFill, Tone | undefined>;

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

/** How full the job's context is, when both sides are known. */
function fill(usage: JobUsage): ContextFill | undefined {
  const filled = share(usage);
  return filled === undefined ? undefined : Format.contextFill(filled * 100);
}

/** The tone every surface paints the context share in, as full as it is. */
function tone(usage: JobUsage): Tone | undefined {
  const filled = fill(usage);
  return filled === undefined ? undefined : FILL_TONES[filled];
}

function context(usage: JobUsage): readonly Span[] {
  const filled = share(usage);
  if (filled === undefined) {
    return [];
  }
  const toned = tone(usage);
  return [
    {
      text: `${(filled * 100).toFixed(1)}%/${Format.formatTokens(usage.contextWindow!)}`,
      ...(toned === undefined ? {} : { tone: toned }),
    },
  ];
}

/** `4 turns`, `$0.12`, then `5.0%/1.0M` when the context is known, toned by how full it is. */
function usage(job: JobUsage): readonly Span[] {
  return [
    { text: Format.count(job.turns, "turn") },
    { text: `$${job.cost.toFixed(2)}` },
    ...context(job),
  ];
}

function parts(job: JobView, now: number): JobLineParts {
  return {
    handle: job.handle,
    stats: usage(job),
    elapsed: Format.formatElapsed(now - job.startedAt),
  };
}

/** The model's line for a running job. */
function text(job: JobView, now: number): string {
  return [
    `- ${job.handle}`,
    Format.formatElapsed(now - job.startedAt),
    ...usage(job).map((span) => span.text),
    oneLine(job.title),
  ].join(" · ");
}

export const JobLine = {
  SEPARATOR,
  share,
  fill,
  tone,
  parts,
  usage,
  text,
  handleNumber,
};
