import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

import { Renderer } from "../../shared/Renderer";
import type { ToolViewInput } from "../../shared/Tools";
import type { Span, Tone, ToolView, ViewBlock } from "../../view/ViewBlock";
import type {
  SpawnDetails,
  SubagentAction,
  SubagentArgs,
  subagentSchema,
  SubagentToolDetails,
} from "./schema";
import type { SubagentDetails } from "./subagent";
import { JobLine } from "./JobLine";
import type { JobState } from "./JobState";
import type { SubagentResultMessage } from "./SubagentResult";

const SEPARATOR: Span = { text: JobLine.SEPARATOR, tone: "muted" };

type SubagentViewInput = ToolViewInput<
  typeof subagentSchema,
  SubagentToolDetails
>;

type RunViewInput = {
  readonly prompt: string | undefined;
  readonly result: AgentToolResult<SubagentDetails | undefined> | undefined;
  readonly isPartial: boolean;
};

const STATE_TONES = {
  done: "accent",
  failed: "error",
  stopped: "warning",
  interrupted: "error",
} as const satisfies Record<JobState, Tone>;

export function subagentView({
  args,
  result,
  isPartial,
}: SubagentViewInput): ToolView {
  const call = (args ?? {}) as SubagentArgs;
  const details = result?.details;
  const job =
    details !== undefined && "action" in details ? details : undefined;
  const action = job?.action ?? call.action ?? "spawn";
  if (action !== "spawn") {
    return actionView(action, call, result, isPartial);
  }
  if (job?.action === "spawn") {
    return spawnedView(job);
  }
  return runView({
    prompt: call.prompt,
    result: result as RunViewInput["result"],
    isPartial,
  });
}

/** A `subagent_result` message, laid out as the run it reports. */
export function subagentResultView(
  message: Pick<SubagentResultMessage, "content" | "details">
): ToolView {
  const { details } = message;
  const run = runView({
    prompt: details.prompt,
    result: { content: [{ type: "text", text: message.content }], details },
    isPartial: false,
  });
  const notice = resultNotice(message);
  return {
    ...run,
    labelTone: STATE_TONES[details.state],
    title: line([
      { text: details.handle },
      ...(details.state === "done"
        ? []
        : [{ text: stateText(details), tone: STATE_TONES[details.state] }]),
      ...usageSpans(details, false),
    ]),
    body: notice === undefined ? run.body : [notice, ...(run.body ?? [])],
  };
}

export function formatCallTitle(prompt: string | undefined): string {
  return (prompt ?? "...").split(/\r?\n/u)[0]?.trim() || "...";
}

/** The usage line as plain text, for streaming updates. */
export function formatTopLine(details: SubagentDetails): string {
  return usageSpans(details, details.stopReason === undefined)
    .map((span) => span.text)
    .join(SEPARATOR.text);
}

function resultNotice({
  content,
  details,
}: Pick<SubagentResultMessage, "content" | "details">): ViewBlock | undefined {
  if (details.state === "stopped") {
    return details.reason === undefined
      ? undefined
      : { kind: "notice", severity: "info", text: details.reason };
  }
  if (details.state === "done") {
    return undefined;
  }
  const line = content.split("\n")[1]?.trim() ?? "";
  return line === ""
    ? undefined
    : { kind: "notice", severity: "error", text: line };
}

function stateText(details: SubagentResultMessage["details"]): string {
  return details.state === "stopped" && details.stoppedBy !== undefined
    ? `stopped by ${details.stoppedBy}`
    : details.state;
}

function runView({ prompt, result, isPartial }: RunViewInput): ToolView {
  return {
    label: "Subagent",
    icon: "robot",
    labelTone: labelTone(result, isPartial),
    title: line(
      result?.details === undefined ? [] : usageSpans(result.details, isPartial)
    ),
    body: bodyBlocks(prompt, result),
  };
}

function spawnedView(details: SpawnDetails): ToolView {
  return {
    label: "Subagent",
    icon: "robot",
    labelTone: "accent",
    title: line([{ text: details.handle }, { text: "started", tone: "muted" }]),
    body: promptSection(details.prompt),
  };
}

function actionView(
  action: Exclude<SubagentAction, "spawn">,
  call: SubagentArgs,
  result: AgentToolResult<unknown> | undefined,
  isPartial: boolean
): ToolView {
  const text = result === undefined ? "" : Renderer.firstText(result);
  const reason = action === "stop" ? call.reason : undefined;
  return {
    label: "Subagent",
    icon: "robot",
    labelTone: isPartial || result === undefined ? "warning" : "accent",
    title: line([
      ...(call.id === undefined ? [] : [{ text: call.id }]),
      { text: action },
      ...(reason === undefined
        ? []
        : [{ text: reason, tone: "muted" as const }]),
    ]),
    body: [
      ...(action === "steer" && call.message !== undefined
        ? [
            {
              kind: "section" as const,
              label: "Message",
              content: [{ kind: "text" as const, text: call.message }],
            },
          ]
        : []),
      ...(text === "" ? [] : [{ kind: "text" as const, text }]),
    ],
  };
}

function labelTone(
  result: RunViewInput["result"],
  isPartial: boolean
): ToolView["labelTone"] {
  if (isPartial || result === undefined) {
    return "warning";
  }
  return result.details === undefined ? "error" : "accent";
}

/** Spans joined by `SEPARATOR`, as one line. */
function line(spans: readonly Span[]): readonly ViewBlock[] {
  return spans.length === 0
    ? []
    : [
        {
          kind: "spans",
          spans: spans.flatMap((span, index): readonly Span[] =>
            index === 0 ? [span] : [SEPARATOR, span]
          ),
        },
      ];
}

function usageSpans(
  details: SubagentDetails,
  isPartial: boolean
): readonly Span[] {
  // pi empties `details` on failure, and old sessions lack usage.
  if (details.usage === undefined) {
    return [];
  }
  const tone: Tone = isPartial ? "warning" : "muted";
  return JobLine.usage({
    ...details.usage,
    contextWindow: details.contextWindow,
  }).map((text) => ({ text, tone }));
}

function promptSection(prompt: string | undefined): readonly ViewBlock[] {
  return prompt !== undefined && prompt.trim() !== ""
    ? [
        {
          kind: "section",
          label: "Prompt",
          content: [{ kind: "text", text: prompt.trim() }],
        },
      ]
    : [];
}

function bodyBlocks(
  prompt: string | undefined,
  result: RunViewInput["result"]
): readonly ViewBlock[] {
  const blocks: ViewBlock[] = [...promptSection(prompt)];
  if (result === undefined) {
    return blocks;
  }

  const details = result.details;

  const text = details?.fullOutput ?? Renderer.firstText(result);
  if (text !== "") {
    blocks.push({ kind: "markdown", text });
  }

  const pairs = footPairs(details);
  if (pairs.length > 0) {
    blocks.push({ kind: "kv", pairs });
  }

  return blocks;
}

function footPairs(
  details: SubagentDetails | undefined
): ReadonlyArray<readonly [string, string]> {
  return details?.model === undefined ? [] : [["model", details.model]];
}
