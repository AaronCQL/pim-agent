import type { ToolViewInput } from "../../shared/Tools";
import type { Span, ToolView, ViewBlock } from "../../shared/view/ViewBlock";
import type { subagentSchema } from "./schema";
import type { SubagentDetails, SubagentSnapshot } from "./subagent";

const DOT = "⬝";

type SubagentViewInput = ToolViewInput<typeof subagentSchema, SubagentDetails>;

type StatusFields = Pick<
  SubagentSnapshot,
  | "usage"
  | "toolCalls"
  | "activeToolNames"
  | "lastToolName"
  | "stopReason"
  | "model"
  | "contextWindow"
>;

/**
 * The status line lives on `summary` so it stays visible while the subagent
 * streams and while the row is collapsed; the final message is `body`, which
 * only the expanded row shows. `details` carries everything both need, so a
 * replayed session renders exactly like the live run did.
 */
export function subagentView({
  args,
  result,
  isPartial,
}: SubagentViewInput): ToolView {
  return {
    label: "Subagent",
    labelTone: labelTone(result, isPartial),
    title: [{ kind: "markdown", text: formatCallTitle(args?.prompt) }],
    summary: summaryBlocks(result?.details, isPartial),
    body: bodyBlocks(result),
  };
}

export function formatCallTitle(prompt: string | undefined): string {
  return (prompt ?? "...").split(/\r?\n/u)[0]?.trim() || "...";
}

export function formatTopLine(snapshot: StatusFields): string {
  return [
    formatCost(snapshot.usage.cost),
    formatContext(snapshot),
    snapshot.model ?? "unknown model",
    formatActivity(snapshot),
  ].join(` ${DOT} `);
}

/**
 * A finished run always reports its usage, so a result that carries no details
 * is one pi built out of a thrown failure.
 */
function labelTone(
  result: SubagentViewInput["result"],
  isPartial: boolean
): ToolView["labelTone"] {
  if (isPartial || result === undefined) {
    return "warning";
  }
  return result.details === undefined ? "error" : "accent";
}

/** Dots stay muted so the segments they separate read as one line of stats. */
function summaryBlocks(
  details: SubagentDetails | undefined,
  isPartial: boolean
): readonly ViewBlock[] {
  const topLine = details?.topLine;
  if (!topLine) {
    return [];
  }

  const tone = isPartial ? "warning" : "accent";
  const spans: Span[] = [];
  topLine.split(DOT).forEach((part, index) => {
    if (index > 0) {
      spans.push({ text: DOT, tone: "muted" });
    }
    spans.push({ text: part, tone });
  });

  return [{ kind: "spans", spans }];
}

function bodyBlocks(result: SubagentViewInput["result"]): readonly ViewBlock[] {
  const first = result?.content?.[0];
  const text = first && "text" in first ? (first.text ?? "") : "";
  return text === "" ? [] : [{ kind: "markdown", text }];
}

function formatActivity(snapshot: StatusFields): string {
  const turns = `${snapshot.usage.turns} ${snapshot.usage.turns === 1 ? "turn" : "turns"}`;
  if (snapshot.stopReason !== undefined) {
    const toolCount = snapshot.toolCalls.length;
    return toolCount > 0
      ? `${turns} ${DOT} ${toolCount} ${toolCount === 1 ? "tool" : "tools"}`
      : turns;
  }

  return `${turns} ${DOT} ${activeToolLabel(snapshot)}`;
}

function activeToolLabel(snapshot: StatusFields): string {
  if (snapshot.activeToolNames.length === 1) {
    return snapshot.activeToolNames[0]!;
  }
  if (snapshot.activeToolNames.length > 1) {
    return `${snapshot.activeToolNames.length} tools`;
  }
  return snapshot.lastToolName ?? "thinking";
}

function formatContext(snapshot: StatusFields): string {
  const window = snapshot.contextWindow;
  if (!window || window <= 0) {
    return "?/?";
  }
  const windowText = formatTokens(window);
  const tokens = snapshot.usage.contextTokens;
  if (tokens === undefined) {
    return `?/${windowText}`;
  }
  return `${((tokens / window) * 100).toFixed(1)}%/${windowText}`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) {
    return `${tokens}`;
  }
  if (tokens < 10_000) {
    return `${(tokens / 1000).toFixed(1)}K`;
  }
  if (tokens < 1_000_000) {
    return `${Math.round(tokens / 1000)}K`;
  }
  if (tokens < 10_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1_000_000)}M`;
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}
