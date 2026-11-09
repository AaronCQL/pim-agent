import { Format } from "../../shared/Format";
import { Json } from "../../shared/Json";
import { JobLine, type JobUsage } from "./JobLine";
import type { ToolTrace } from "./subagent";
import type { JobView } from "./SubagentJobs";
import { SubagentResult } from "./SubagentResult";

const CUSTOM_TYPE = "subagent_notice";
/** The share of its context window at which a running job tells its parent, once. */
const THRESHOLD = 0.4;
const RECENT_TOOLS = 3;

export type SubagentNoticeDetails = {
  readonly jobId: string;
  /** The job's short name in its session, `j3`. */
  readonly handle: string;
  readonly contextTokens: number;
  readonly contextWindow: number;
  readonly turns: number;
  readonly elapsedMs: number;
  readonly cost: number;
  readonly tools: readonly ToolTrace[];
};

export type SubagentNoticeMessage = {
  readonly customType: typeof CUSTOM_TYPE;
  readonly content: string;
  readonly display: true;
  readonly details: SubagentNoticeDetails;
};

type Known = JobUsage & {
  readonly contextTokens: number;
  readonly contextWindow: number;
};

export type NoticeStats = Known & {
  readonly jobId: string;
  readonly handle: string;
  readonly elapsedMs: number;
};

/** The usage is at or past the threshold, with both sides known. */
function crossed(usage: JobUsage): usage is Known {
  const { contextTokens, contextWindow } = usage;
  return (
    contextTokens !== undefined &&
    contextWindow !== undefined &&
    contextWindow > 0 &&
    contextTokens / contextWindow >= THRESHOLD
  );
}

/** `⚠ 40%` for a job whose notice was issued. */
function flag(job: JobView): readonly string[] {
  return job.noticed === true ? [`⚠ ${THRESHOLD * 100}%`] : [];
}

function percent(details: SubagentNoticeDetails): string {
  return `${Math.floor((details.contextTokens / details.contextWindow) * 100)}%`;
}

function stats(usage: JobUsage, elapsedMs: number): readonly string[] {
  return [...JobLine.usage(usage), Format.formatElapsed(elapsedMs)];
}

function of(
  job: NoticeStats,
  tools: readonly ToolTrace[]
): SubagentNoticeMessage {
  const details: SubagentNoticeDetails = {
    jobId: job.jobId,
    handle: job.handle,
    contextTokens: job.contextTokens,
    contextWindow: job.contextWindow,
    turns: job.turns,
    elapsedMs: job.elapsedMs,
    cost: job.cost,
    tools: tools.slice(-RECENT_TOOLS),
  };
  return {
    customType: CUSTOM_TYPE,
    content: [
      `[subagent job ${details.handle} at ${percent(details)} context, still running]`,
      stats(details, details.elapsedMs).join(" · "),
      ...SubagentResult.toolLines(details.tools),
      "Your call: let it finish, steer it to wrap up, or steer it to hand off (tell it to commit work in progress and report what's done, what's left, its decisions and anything failing). Doing nothing is fine.",
    ].join("\n"),
    display: true,
    details,
  };
}

/** The one muted line every surface shows for a notice; its head already gives the share. */
function line(details: SubagentNoticeDetails): string {
  return [
    `⚠ ${details.handle} at ${percent(details)} context`,
    ...stats({ turns: details.turns, cost: details.cost }, details.elapsedMs),
  ].join(" · ");
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** A custom message's details, if it is a `subagent_notice` with every field `line` reads. */
function detailsOf(message: {
  readonly customType: string;
  readonly details?: unknown;
}): SubagentNoticeDetails | undefined {
  if (message.customType !== CUSTOM_TYPE) {
    return undefined;
  }
  const details = Json.asRecord(message.details);
  return typeof details?.["jobId"] === "string" &&
    typeof details["handle"] === "string" &&
    isCount(details["contextTokens"]) &&
    isCount(details["contextWindow"]) &&
    details["contextWindow"] > 0 &&
    isCount(details["turns"]) &&
    isCount(details["cost"]) &&
    isCount(details["elapsedMs"])
    ? (details as SubagentNoticeDetails)
    : undefined;
}

export const SubagentNotice = {
  CUSTOM_TYPE,
  THRESHOLD,
  crossed,
  flag,
  of,
  line,
  detailsOf,
};
