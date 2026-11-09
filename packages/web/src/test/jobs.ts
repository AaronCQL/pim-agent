import type { JobView } from "#core/extensions/subagent/SubagentJobs";
import type { JobState } from "#core/extensions/subagent/JobState";
import type { SubagentResultMessage } from "#core/extensions/subagent/SubagentResult";
import {
  subagentResultView,
  subagentView,
} from "#core/extensions/subagent/render";
import type {
  SubagentInput,
  SubagentToolDetails,
} from "#core/extensions/subagent/schema";
import type { ToolView } from "#core/view/ViewBlock";
import type { ServerEvent } from "#protocol/ServerEvent";

const USAGE = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0.04,
  turns: 2,
  contextTokens: 4000,
};

function view(
  args: Partial<SubagentInput>,
  details: SubagentToolDetails | undefined,
  text = ""
): ToolView {
  return subagentView({
    args: args as SubagentInput,
    ...(details === undefined
      ? {}
      : { result: { content: [{ type: "text", text }], details } }),
    isPartial: false,
    cwd: "/repo",
  });
}

export function spawnView(jobId: string, prompt: string) {
  return view(
    { action: "spawn", prompt },
    {
      action: "spawn",
      jobId,
      handle: "j1",
      prompt,
      owner: { pid: 1, hostname: "box" },
    },
    "Started job j1."
  );
}

export function statusView(id: string): ToolView {
  return view(
    { action: "status", id },
    { action: "status", id, jobs: [] },
    "running"
  );
}

export function stopView(id: string): ToolView {
  return view(
    { action: "stop", id, reason: "wrong file" },
    { action: "stop", jobIds: [id], reason: "wrong file" },
    "stopped"
  );
}

export function steerView(id: string): ToolView {
  return view(
    { action: "steer", id, message: "look in src/" },
    { action: "steer", jobId: id, message: "look in src/" },
    "steered"
  );
}

/** A run from before jobs, or with no `jobs` registry: no `action` anywhere. */
export function syncRunView(prompt: string): ToolView {
  return view({ prompt }, undefined);
}

export function resultView(
  jobId: string,
  state: JobState,
  options: { readonly line?: string } = {}
): ToolView {
  const message: Pick<SubagentResultMessage, "content" | "details"> = {
    content: `[subagent job j1 ${state}]\n${options.line ?? "the answer"}`,
    details: {
      jobId,
      handle: "j1",
      prompt: "audit the parser",
      state,
      ...(state === "stopped" ? { stoppedBy: "user" as const } : {}),
      sessionId: undefined,
      usage: USAGE,
      stopReason: state === "done" ? "stop" : undefined,
      errorMessage: undefined,
      model: "echo",
      contextWindow: 200_000,
      returnedOutput: "the answer",
      fullOutput: "the answer",
      outputTruncated: false,
      omittedBytes: 0,
    },
  };
  return subagentResultView(message);
}

export function result(
  seq: number,
  jobId: string,
  state: JobState,
  options: { readonly line?: string } = {}
): ServerEvent {
  return {
    seq,
    type: "subagent_result",
    messageId: `entry-${seq}`,
    jobId,
    handle: "j1",
    state,
    view: resultView(jobId, state, options),
    timestamp: 0,
  };
}

export function notice(seq: number, jobId: string): ServerEvent {
  return {
    seq,
    type: "subagent_notice",
    messageId: `entry-${seq}`,
    jobId,
    handle: "j1",
    text: "⚠ j1 at 40% context · 80K/200K · 2 turns · 1m 0s",
    timestamp: 0,
  };
}

export function job(id: string, extra: Partial<JobView> = {}): JobView {
  return {
    id,
    handle: "j1",
    title: `task ${id}`,
    startedAt: 0,
    turns: 1,
    cost: 0,
    ...extra,
  };
}

export function jobs(...list: readonly JobView[]): ServerEvent {
  return { type: "jobs", jobs: list };
}
