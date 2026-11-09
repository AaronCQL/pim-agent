import { Format, type ContextFill } from "../../shared/Format";
import { Json } from "../../shared/Json";
import { JobLine, type JobUsage } from "./JobLine";
import type { ToolTrace } from "./subagent";
import { SubagentResult, type CustomMessageLike } from "./SubagentResult";

const CUSTOM_TYPE = "subagent_notice";
const RECENT_TOOLS = 3;
const HAND_OFF =
  "(tell it to commit work in progress and report what's done, what's left, its decisions and anything failing)";
const ADVICE = {
  warn: `Your call: let it finish, steer it to wrap up, or steer it to hand off ${HAND_OFF}. Doing nothing is fine.`,
  full: `It is running out of room: steer it to hand off now ${HAND_OFF}, unless it is about to finish.`,
} as const satisfies Record<NoticeLevel, string>;

/** A running job tells its parent once per level, the first time its context reaches it. */
export type NoticeLevel = Exclude<ContextFill, "ok">;

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

export type NoticeStats = Omit<SubagentNoticeDetails, "tools">;

/** The notice level the usage has reached, if any. */
function level(usage: JobUsage): NoticeLevel | undefined {
  const fill = JobLine.fill(usage);
  return fill === "ok" ? undefined : fill;
}

function percent(details: SubagentNoticeDetails): string {
  return `${Math.floor(JobLine.share(details)! * 100)}%`;
}

function stats(usage: JobUsage, elapsedMs: number): readonly string[] {
  return [
    ...JobLine.usage(usage).map((span) => span.text),
    Format.formatElapsed(elapsedMs),
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
      stats(details, details.elapsedMs).join(" · "),
      ...SubagentResult.toolLines(details.tools),
      ADVICE[level(details) ?? "warn"],
    ].join("\n"),
    display: true,
    details,
  };
}

/** What every surface shows for a notice, after the job's handle. */
function line(details: SubagentNoticeDetails): string {
  return `context at ${percent(details)}`;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** A custom message's details, if it is a `subagent_notice` with every field `line` reads. */
function detailsOf(
  message: CustomMessageLike
): SubagentNoticeDetails | undefined {
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
  level,
  of,
  line,
  detailsOf,
};
