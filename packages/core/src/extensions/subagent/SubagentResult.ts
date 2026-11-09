import type {
  AgentSessionEvent,
  AgentToolResult,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { Errors } from "../../shared/Errors";
import { Json } from "../../shared/Json";
import { Renderer } from "../../shared/Renderer";
import { EventLog } from "../../session/EventLog";
import type { JobState } from "./JobState";
import {
  applyOutputCap,
  SubagentEventCapture,
  type SubagentDetails,
  type ToolTrace,
} from "./subagent";

const CUSTOM_TYPE = "subagent_result";

export type StoppedBy = "user" | "agent";

export type SubagentResultDetails = SubagentDetails & {
  readonly jobId: string;
  /** The job's short name in its session, `j3`. */
  readonly handle: string;
  readonly prompt: string;
  readonly state: JobState;
  readonly stoppedBy?: StoppedBy;
  /** Why the agent stopped it. */
  readonly reason?: string;
  /** The child's log, for an interrupted job. */
  readonly logPath?: string;
};

export type SubagentResultMessage = {
  readonly customType: typeof CUSTOM_TYPE;
  readonly content: string;
  readonly display: true;
  readonly details: SubagentResultDetails;
};

export type JobIdentity = {
  readonly jobId: string;
  readonly handle: string;
  readonly prompt: string;
};

export type JobStop = { readonly by: StoppedBy; readonly reason?: string };

export type JobOutcome =
  | { readonly ok: true; readonly result: AgentToolResult<SubagentDetails> }
  | { readonly ok: false; readonly error: unknown };

/** How a job ended, as the registry saw it. */
export type JobEnd = {
  readonly outcome: JobOutcome;
  readonly details: SubagentDetails;
  readonly tools: readonly ToolTrace[];
  readonly stop: JobStop | undefined;
  /** The parent's other running jobs, by name. */
  readonly stillRunning: readonly string[];
};

/** What a custom message's type and details are read from, before it is known to be a job's. */
export type CustomMessageLike = {
  readonly customType: string;
  readonly details?: unknown;
};

function headline(job: JobIdentity, state: string): string {
  return `[subagent job ${job.handle} ${state}]`;
}

function message(
  job: JobIdentity,
  content: string,
  details: SubagentDetails &
    Pick<SubagentResultDetails, "state" | "stoppedBy" | "reason" | "logPath">
): SubagentResultMessage {
  return {
    customType: CUSTOM_TYPE,
    content,
    display: true,
    details: {
      ...details,
      jobId: job.jobId,
      handle: job.handle,
      prompt: job.prompt,
    },
  };
}

function toolLines(tools: readonly ToolTrace[]): readonly string[] {
  return tools.length === 0
    ? []
    : [
        "Recent tool calls:",
        ...tools.map((tool) => `- ${tool.title} (${tool.state})`),
      ];
}

function partial(
  details: SubagentDetails,
  tools: readonly ToolTrace[]
): string {
  const text = applyOutputCap(details.fullOutput).text;
  return [
    "Partial output:",
    text === "" ? "(no text output yet)" : text,
    ...toolLines(tools),
  ].join("\n");
}

/** A finished child as the one message its parent gets. A stop that lost the race to completion still reads as done. */
function of(job: JobIdentity, end: JobEnd): SubagentResultMessage {
  const { outcome, details, tools, stop } = end;
  const others =
    end.stillRunning.length === 0
      ? "No other jobs running."
      : `Still running: ${end.stillRunning.join(", ")}.`;
  const stoppedBy =
    stop === undefined
      ? {}
      : {
          stoppedBy: stop.by,
          ...(stop.reason === undefined ? {} : { reason: stop.reason }),
        };
  if (outcome.ok) {
    return message(
      job,
      `${headline(job, "done")}\n${Renderer.firstText(outcome.result)}\n\n${others}`,
      { ...outcome.result.details, state: "done", ...stoppedBy }
    );
  }
  if (stop !== undefined) {
    const why = stop.reason === undefined ? "" : `: ${stop.reason}`;
    return message(
      job,
      `${headline(job, `stopped by ${stop.by}${why}`)}\n${partial(details, tools)}\n\n${others}`,
      { ...details, state: "stopped", ...stoppedBy }
    );
  }
  return message(
    job,
    [
      headline(job, "failed"),
      Errors.describe(outcome.error),
      ...toolLines(tools),
      "",
      others,
    ].join("\n"),
    { ...details, state: "failed" }
  );
}

const NORMAL_ENDS = new Set(["stop", "length"]);

type LoggedMessage = Extract<SessionEntry, { type: "message" }>["message"];

/** Replays a child log's message, tool calls included, as the live capture saw it. */
function replay(capture: SubagentEventCapture, logged: LoggedMessage): void {
  if (logged.role === "toolResult") {
    capture.handle({
      type: "tool_execution_end",
      toolCallId: logged.toolCallId,
      toolName: logged.toolName,
      result: logged,
      isError: logged.isError,
    } as AgentSessionEvent);
    return;
  }
  if (logged.role !== "assistant") {
    return;
  }
  capture.handle({ type: "message_end", message: logged });
  for (const block of logged.content) {
    if (block.type === "toolCall") {
      capture.handle({
        type: "tool_execution_start",
        toolCallId: block.id,
        toolName: block.name,
        args: block.arguments,
      } as AgentSessionEvent);
    }
  }
}

/** Rebuilds a job's result from its child log, for a job whose process is gone. */
async function fromLog(
  job: JobIdentity,
  logPath: string
): Promise<SubagentResultMessage> {
  const capture = new SubagentEventCapture();
  for (const { entry } of await new EventLog(logPath).read()) {
    if (entry.type === "message") {
      replay(capture, entry.message);
    }
  }
  const details = capture.details();
  if (NORMAL_ENDS.has(details.stopReason ?? "")) {
    const text =
      details.returnedOutput ||
      "[subagent tool: completed with no text output.]";
    return message(job, `${headline(job, "done")}\n${text}`, {
      ...details,
      state: "done",
    });
  }
  return message(
    job,
    `${headline(job, "interrupted")}\nThe process running this job ended before it finished; full log at ${logPath}.\n${partial(details, capture.recentTools())}`,
    { ...details, state: "interrupted", logPath }
  );
}

/** A custom message's details, if it is a `subagent_result` naming its job. */
function detailsOf(
  message: CustomMessageLike
): SubagentResultDetails | undefined {
  if (message.customType !== CUSTOM_TYPE) {
    return undefined;
  }
  const details = Json.asRecord(message.details);
  return typeof details?.["jobId"] === "string"
    ? (details as SubagentResultDetails)
    : undefined;
}

/** The job a `subagent_result` entry reports, if it is one. */
function jobIdOf(entry: SessionEntry): string | undefined {
  return entry.type === "custom_message" ? detailsOf(entry)?.jobId : undefined;
}

export const SubagentResult = {
  CUSTOM_TYPE,
  of,
  fromLog,
  detailsOf,
  jobIdOf,
  toolLines,
};
