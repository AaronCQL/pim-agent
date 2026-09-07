import { Format } from "../../shared/Format";
import { Renderer } from "../../shared/Renderer";
import type { ToolViewInput } from "../../shared/Tools";
import type { Span, Tone, ToolView, ViewBlock } from "../../view/ViewBlock";
import type { subagentSchema } from "./schema";
import type { SubagentDetails, SubagentEntry } from "./subagent";

const DOT = "⬝";

/**
 * How many distinct tool names the roster names before it elides. Past this
 * the summary stops being one line on a phone, and the names it would add are
 * the ones the run used least.
 */
const ROSTER_CAP = 8;

type SubagentViewInput = ToolViewInput<typeof subagentSchema, SubagentDetails>;

type ToolTally = { count: number; failures: number };

/**
 * The summary is what the run did — roster, turns, cost — and it renders in
 * every state, so it is the whole of a collapsed row. The body is what the
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
 */
function summarySpans(
  details: SubagentDetails,
  isPartial: boolean
): readonly Span[] {
  // `details` is only as current as whatever wrote it: pi replaces a failed
  // result with an empty object, and a session recorded before the roster
  // existed replays without one. Both arrive typed as a whole
  // `SubagentDetails` and are neither.
  if (details.usage === undefined) {
    return [];
  }

  const tone: Tone = isPartial ? "warning" : "muted";
  const segments = [
    ...rosterSegments(details.entries ?? [], tone),
    [{ text: formatTurns(details.usage.turns), tone }],
    [{ text: formatCost(details.usage.cost), tone }],
    ...(details.stopReason === undefined
      ? [[{ text: `${activeToolLabel(details)}…`, tone: "warning" as const }]]
      : []),
  ];

  return segments.flatMap((spans, index) =>
    index === 0
      ? spans
      : [{ text: ` ${DOT} `, tone: "muted" as const }, ...spans]
  );
}

/** `read ×6`, in the order the child first reached for each tool. */
function rosterSegments(
  entries: readonly SubagentEntry[],
  tone: Tone
): ReadonlyArray<readonly Span[]> {
  const tallies = new Map<string, ToolTally>();
  for (const entry of entries) {
    if (entry.kind !== "tool") {
      continue;
    }
    const tally = tallies.get(entry.name) ?? { count: 0, failures: 0 };
    tally.count += 1;
    tally.failures += entry.isError ? 1 : 0;
    tallies.set(entry.name, tally);
  }

  const named = Array.from(tallies).slice(0, ROSTER_CAP);
  const segments = named.map(([name, tally]): readonly Span[] => {
    const label = tally.count === 1 ? name : `${name} ×${tally.count}`;
    return tally.failures === 0
      ? [{ text: label, tone }]
      : [
          { text: label, tone },
          { text: ` (${tally.failures} failed)`, tone: "error" },
        ];
  });

  const elided = tallies.size - named.length;
  return elided === 0
    ? segments
    : [...segments, [{ text: `… ${elided} more`, tone }]];
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
 * The child's own context window and model, which say nothing about what the
 * run achieved and are identical on every row of a session.
 */
function footPairs(
  details: SubagentDetails | undefined
): ReadonlyArray<readonly [string, string]> {
  const pairs: Array<readonly [string, string]> = [];
  if (details === undefined) {
    return pairs;
  }

  const context = formatContext(details);
  if (context !== undefined) {
    pairs.push(["context", context]);
  }
  if (details.model !== undefined) {
    pairs.push(["model", details.model]);
  }
  return pairs;
}

function activeToolLabel(details: SubagentDetails): string {
  if (details.activeToolNames.length === 1) {
    return details.activeToolNames[0]!;
  }
  if (details.activeToolNames.length > 1) {
    return `${details.activeToolNames.length} tools`;
  }
  return details.lastToolName ?? "thinking";
}

function formatContext(details: SubagentDetails): string | undefined {
  const window = details.contextWindow;
  // Optional even though the type says otherwise: an emptied `details` from a
  // thrown call reaches here too.
  const tokens = details.usage?.contextTokens;
  if (window === undefined || window <= 0 || tokens === undefined) {
    return undefined;
  }
  return `${((tokens / window) * 100).toFixed(1)}% of ${Format.formatTokens(window)}`;
}

function formatTurns(turns: number): string {
  return `${turns} ${turns === 1 ? "turn" : "turns"}`;
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}
