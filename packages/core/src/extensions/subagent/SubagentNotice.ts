import { Format } from "../../shared/Format";
import { Json } from "../../shared/Json";
import { JobLine, type JobUsage } from "./JobLine";
import type { ToolTrace } from "./subagent";
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

/** `⚠ 40%` for a job past the threshold. */
function flag(usage: JobUsage): readonly string[] {
  return crossed(usage) ? [`⚠ ${THRESHOLD * 100}%`] : [];
}

function percent(details: SubagentNoticeDetails): string {
  return `${Math.floor((details.contextTokens / details.contextWindow) * 100)}%`;
}

function stats(details: SubagentNoticeDetails): readonly string[] {
  return [
    JobLine.fill(details.contextTokens, details.contextWindow),
    Format.count(details.turns, "turn"),
    Format.formatElapsed(details.elapsedMs),
  ];
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
      [...stats(details), JobLine.cost(details.cost)].join(" · "),
      ...SubagentResult.toolLines(details.tools),
      "Your call: let it finish, steer it to wrap up, or steer it to hand off. If you hand off, it commits work in progress and reports what's done, what's left, its decisions and anything failing. Doing nothing is fine.",
    ].join("\n"),
    display: true,
    details,
  };
}

/** The one muted line every surface shows for a notice. */
function line(details: SubagentNoticeDetails): string {
  return [
    `⚠ ${details.handle} at ${percent(details)} context`,
    ...stats(details),
  ].join(" · ");
}

/** A custom message's details, if it is a `subagent_notice` naming its job. */
function detailsOf(message: {
  readonly customType: string;
  readonly details?: unknown;
}): SubagentNoticeDetails | undefined {
  if (message.customType !== CUSTOM_TYPE) {
    return undefined;
  }
  const details = Json.asRecord(message.details);
  return typeof details?.["jobId"] === "string" &&
    typeof details["contextTokens"] === "number" &&
    typeof details["contextWindow"] === "number"
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
