import { Format } from "../../shared/Format";
import { Renderer } from "../../shared/Renderer";
import type { ToolViewInput } from "../../shared/Tools";
import type { Span, Tone, ToolView, ViewBlock } from "../../view/ViewBlock";
import type { subagentSchema } from "./schema";
import type { SubagentDetails } from "./subagent";

const SEPARATOR: Span = { text: " ⬝ ", tone: "muted" };

type SubagentViewInput = ToolViewInput<typeof subagentSchema, SubagentDetails>;

export function subagentView({
  args,
  result,
  isPartial,
}: SubagentViewInput): ToolView {
  return {
    label: "Subagent",
    icon: "robot",
    labelTone: labelTone(result, isPartial),
    title: [{ kind: "markdown", text: formatCallTitle(args?.prompt) }],
    summary: summaryBlocks(result?.details, isPartial),
    body: bodyBlocks(args?.prompt, result),
  };
}

export function formatCallTitle(prompt: string | undefined): string {
  return (prompt ?? "...").split(/\r?\n/u)[0]?.trim() || "...";
}

/** The status line the parent model reads while the call streams: the summary flattened. */
export function formatTopLine(details: SubagentDetails): string {
  return summarySpans(details, details.stopReason === undefined)
    .map((span) => span.text)
    .join("");
}

function labelTone(
  result: SubagentViewInput["result"],
  isPartial: boolean
): ToolView["labelTone"] {
  if (isPartial || result === undefined) {
    return "warning";
  }
  return result.details === undefined ? "error" : "accent";
}

function summaryBlocks(
  details: SubagentDetails | undefined,
  isPartial: boolean
): readonly ViewBlock[] {
  const spans = details === undefined ? [] : summarySpans(details, isPartial);
  return spans.length === 0 ? [] : [{ kind: "spans", spans }];
}

function summarySpans(
  details: SubagentDetails,
  isPartial: boolean
): readonly Span[] {
  // `details` is typed whole but may not be: pi empties it on failure, and old sessions lack usage.
  if (details.usage === undefined) {
    return [];
  }

  const tone: Tone = isPartial ? "warning" : "muted";
  const parts = [
    Format.count(details.usage.turns, "turn"),
    formatCost(details.usage.cost),
    formatContext(details.usage.contextTokens, details.contextWindow),
  ].filter((part) => part !== undefined);

  return parts.flatMap((text, index): readonly Span[] =>
    index === 0 ? [{ text, tone }] : [SEPARATOR, { text, tone }]
  );
}

function bodyBlocks(
  prompt: string | undefined,
  result: SubagentViewInput["result"]
): readonly ViewBlock[] {
  if (result === undefined) {
    return [];
  }

  const details = result.details;
  const blocks: ViewBlock[] = [];

  if (prompt !== undefined && prompt.trim().includes("\n")) {
    blocks.push({
      kind: "section",
      label: "Prompt",
      content: [{ kind: "text", text: prompt.trim() }],
    });
  }

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

function formatContext(
  tokens: number | undefined,
  window: number | undefined
): string | undefined {
  if (window === undefined || window <= 0 || tokens === undefined) {
    return undefined;
  }
  return `${((tokens / window) * 100).toFixed(1)}%/${Format.formatTokens(window)}`;
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}
