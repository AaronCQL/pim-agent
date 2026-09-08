import { Format } from "../../shared/Format";
import { Renderer } from "../../shared/Renderer";
import type { ToolViewInput } from "../../shared/Tools";
import type { Span, Tone, ToolView, ViewBlock } from "../../view/ViewBlock";
import type { subagentSchema } from "./schema";
import type { SubagentDetails } from "./subagent";

/** The one separator the accounting is joined on, muted in every state. */
const SEPARATOR: Span = { text: " ⬝ ", tone: "muted" };

type SubagentViewInput = ToolViewInput<typeof subagentSchema, SubagentDetails>;

/**
 * The summary is what the run cost — turns, money, context — and it renders
 * in every state, so it is the whole of a collapsed row. The body is what the
 * child wrote, opened on request. `details` carries both, so a replayed
 * session renders exactly like the live run did.
 */
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

/**
 * The status line the parent model reads while the call streams. It is the
 * summary flattened, so the two can never drift apart.
 */
export function formatTopLine(details: SubagentDetails): string {
  return summarySpans(details, details.stopReason === undefined)
    .map((span) => span.text)
    .join("");
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

function summaryBlocks(
  details: SubagentDetails | undefined,
  isPartial: boolean
): readonly ViewBlock[] {
  const spans = details === undefined ? [] : summarySpans(details, isPartial);
  return spans.length === 0 ? [] : [{ kind: "spans", spans }];
}

/**
 * Accounting recedes once the run is over: a settled row reads muted so the
 * answer above it is the loudest thing, and amber means only that the child is
 * still working.
 *
 * Tool names are deliberately absent. A roster of what the child reached for
 * — either tallied over the whole run or named as it happens — is one line
 * standing in for a transcript, and it answers nothing a reader would act on:
 * the run either produced the answer or it did not, and if the how matters,
 * the child's own log is a tap away. What is left is what the parent is
 * actually spending on the delegation.
 */
function summarySpans(
  details: SubagentDetails,
  isPartial: boolean
): readonly Span[] {
  // `details` is only as current as whatever wrote it: pi replaces a failed
  // result with an empty object, and an old enough session replays without
  // usage on it. Both arrive typed as a whole `SubagentDetails` and are
  // neither.
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

/**
 * The prompt whole, then everything the child wrote, then the accounting only
 * a reader who opened the row wants. `Renderer.firstText` is the fallback for
 * a thrown failure, where pi keeps the error text and drops `details`.
 */
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

/**
 * The child's own model, which says nothing about what the run achieved and
 * is identical on every row of a session — so it foots the body rather than
 * riding the summary, where the accounting lives.
 */
function footPairs(
  details: SubagentDetails | undefined
): ReadonlyArray<readonly [string, string]> {
  return details?.model === undefined ? [] : [["model", details.model]];
}

/**
 * `0.4%/1.0M`: how full the child left its own window, over how big that
 * window was. The percentage is the number a reader acts on — a run that came
 * back at 90% is one to split next time — and the window is what makes the
 * percentage mean anything.
 */
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
