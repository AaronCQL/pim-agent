#!/usr/bin/env bun
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ErrorKind, RunResult, VariantId } from "./types";

const VARIANT_ORDER: readonly VariantId[] = ["edit", "apply_patch", "hashline"];
const RUNS_DIR = join(import.meta.dir, "runs");

type GroupStats = {
  readonly model: string;
  readonly tool: VariantId;
  n: number;
  correct: number;
  firstValid: number;
  firstValidDenom: number;
  callsTotal: number;
  errorsTotal: number;
  simpleStrategies: number;
  totalStrategies: number;
  inTokens: number;
  outTokens: number;
  cost: number;
  wallMs: number;
  timedOut: number;
  readonly errorKinds: Map<ErrorKind, number>;
};

function emptyGroup(model: string, tool: VariantId): GroupStats {
  return {
    model,
    tool,
    n: 0,
    correct: 0,
    firstValid: 0,
    firstValidDenom: 0,
    callsTotal: 0,
    errorsTotal: 0,
    simpleStrategies: 0,
    totalStrategies: 0,
    inTokens: 0,
    outTokens: 0,
    cost: 0,
    wallMs: 0,
    timedOut: 0,
    errorKinds: new Map(),
  };
}

export function aggregate(
  results: readonly RunResult[]
): Map<string, GroupStats> {
  const groups = new Map<string, GroupStats>();
  for (const r of results) {
    const key = `${r.model} ${r.tool}`;
    let group = groups.get(key);
    if (!group) {
      group = emptyGroup(r.model, r.tool);
      groups.set(key, group);
    }
    group.n += 1;
    if (r.finalCorrect) {
      group.correct += 1;
    }
    if (r.firstCallValid !== null) {
      group.firstValidDenom += 1;
      if (r.firstCallValid) {
        group.firstValid += 1;
      }
    }
    group.callsTotal += r.editToolCalls;
    group.errorsTotal += r.editToolErrors;
    for (const strategy of r.strategies) {
      group.totalStrategies += 1;
      if (strategy === "simple") {
        group.simpleStrategies += 1;
      }
    }
    for (const kind of r.errorKinds) {
      group.errorKinds.set(kind, (group.errorKinds.get(kind) ?? 0) + 1);
    }
    group.inTokens += r.inputTokens;
    group.outTokens += r.outputTokens;
    group.cost += r.costUsd;
    group.wallMs += r.wallMs;
    if (r.timedOut) {
      group.timedOut += 1;
    }
  }
  return groups;
}

function pct(num: number, den: number): string {
  return den === 0 ? "-" : `${((num / den) * 100).toFixed(0)}%`;
}
function mean(sum: number, den: number): string {
  return den === 0 ? "-" : (sum / den).toFixed(1);
}
function meanInt(sum: number, den: number): string {
  return den === 0 ? "-" : String(Math.round(sum / den));
}
function meanSeconds(sumMs: number, den: number): string {
  return den === 0 ? "-" : (sumMs / den / 1000).toFixed(2);
}
function pad(value: string, width: number): string {
  return value.padStart(width);
}

const HEADERS = [
  "lane",
  "n",
  "pass%",
  "1st%",
  "calls",
  "err",
  "clean%",
  "in",
  "out",
  "cost$",
  "dur(s)",
];
const WIDTHS = [11, 3, 7, 5, 6, 5, 7, 7, 7, 8, 8];

function row(cells: readonly string[]): string {
  return cells
    .map((cell, i) =>
      i === 0 ? cell.padEnd(WIDTHS[i]!) : pad(cell, WIDTHS[i]!)
    )
    .join(" ");
}

function groupRow(g: GroupStats): string {
  return row([
    g.tool,
    String(g.n),
    pct(g.correct, g.n),
    pct(g.firstValid, g.firstValidDenom),
    mean(g.callsTotal, g.n),
    mean(g.errorsTotal, g.n),
    g.tool === "edit" ? pct(g.simpleStrategies, g.totalStrategies) : "-",
    meanInt(g.inTokens, g.n),
    meanInt(g.outTokens, g.n),
    g.cost === 0 ? "0" : (g.cost / g.n).toFixed(5),
    meanSeconds(g.wallMs, g.n),
  ]);
}

function errorLine(g: GroupStats): string | null {
  if (g.errorKinds.size === 0) {
    return null;
  }
  const parts = [...g.errorKinds.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${kind}:${count}`);
  return `    ${g.tool} errors: ${parts.join(", ")}`;
}

type TaskCell = {
  readonly n: number;
  readonly correct: number;
  readonly calls: number;
  readonly in: number;
  readonly out: number;
  readonly cost: number;
  readonly dur: number;
};

function taskCell(
  results: readonly RunResult[],
  model: string,
  taskId: string,
  tool: VariantId
): TaskCell | undefined {
  const rs = results.filter(
    (r) => r.model === model && r.taskId === taskId && r.tool === tool
  );
  if (rs.length === 0) {
    return undefined;
  }
  const total = (pick: (r: RunResult) => number): number =>
    rs.reduce((acc, r) => acc + pick(r), 0);
  return {
    n: rs.length,
    correct: rs.filter((r) => r.finalCorrect).length,
    calls: total((r) => r.editToolCalls) / rs.length,
    in: total((r) => r.inputTokens) / rs.length,
    out: total((r) => r.outputTokens) / rs.length,
    cost: total((r) => r.costUsd) / rs.length,
    dur: total((r) => r.wallMs) / rs.length,
  };
}

const PT_HEADERS = [
  "task",
  "axis",
  "lane",
  "pass",
  "calls",
  "in",
  "Δin",
  "out",
  "Δout",
  "Δcost$",
];
const PT_WIDTHS = [22, 14, 12, 5, 6, 6, 7, 6, 7, 8, 7];

function ptRow(cells: readonly string[]): string {
  return cells
    .map((cell, i) =>
      i < 3 ? cell.padEnd(PT_WIDTHS[i]!) : cell.padStart(PT_WIDTHS[i]!)
    )
    .join(" ");
}

function signed(value: number, digits: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

// Per-task view: when correctness saturates, the signal is in tokens and
// round-trips, and it flips direction by task shape. Aggregating across tasks
// hides that, so break it out per task (grouped by axis), one row per lane.
// Δ columns are versus the `edit` baseline (or the first present lane).
function renderPerTask(results: readonly RunResult[]): readonly string[] {
  const models = [...new Set(results.map((r) => r.model))].sort();
  const tagOf = new Map<string, string>();
  for (const r of results) {
    tagOf.set(r.taskId, r.tag);
  }

  const lines: string[] = [""];
  lines.push(
    "Per task, one row per lane · Δin = input-token delta, Δout = output-token delta, " +
      "Δcost$ = cost delta, all vs the `edit` baseline (− means leaner/cheaper than edit):"
  );
  for (const model of models) {
    lines.push("", model, `  ${ptRow(PT_HEADERS)}`);
    const taskIds = [
      ...new Set(results.filter((r) => r.model === model).map((r) => r.taskId)),
    ].sort(
      (a, b) =>
        (tagOf.get(a) ?? "").localeCompare(tagOf.get(b) ?? "") ||
        a.localeCompare(b)
    );
    for (const taskId of taskIds) {
      const cells = VARIANT_ORDER.map((v) => ({
        variant: v,
        cell: taskCell(results, model, taskId, v),
      })).filter(
        (entry): entry is { variant: VariantId; cell: TaskCell } =>
          entry.cell !== undefined
      );
      if (cells.length === 0) {
        continue;
      }
      const base = cells.find((entry) => entry.variant === "edit") ?? cells[0]!;
      cells.forEach((entry, index) => {
        const c = entry.cell;
        const isBase = entry === base;
        lines.push(
          `  ${ptRow([
            index === 0 ? taskId : "",
            index === 0 ? (tagOf.get(taskId) ?? "") : "",
            entry.variant,
            pct(c.correct, c.n),
            c.calls.toFixed(1),
            String(Math.round(c.in)),
            isBase ? "-" : signed(c.in - base.cell.in, 0),
            String(Math.round(c.out)),
            isBase ? "-" : signed(c.out - base.cell.out, 0),
            isBase ? "-" : signed(c.cost - base.cell.cost, 5),
          ])}`
        );
      });
    }
  }
  return lines;
}

export function renderReport(results: readonly RunResult[]): string {
  if (results.length === 0) {
    return "No results.";
  }
  const groups = aggregate(results);
  const models = [...new Set(results.map((r) => r.model))].sort();

  const lanes = [...new Set(results.map((r) => r.tool))]
    .sort((a, b) => VARIANT_ORDER.indexOf(a) - VARIANT_ORDER.indexOf(b))
    .join(" / ");
  const lines: string[] = [];
  lines.push(`${lanes}  —  ${results.length} runs, ${models.length} model(s)`);
  lines.push("");
  lines.push(`  ${row(HEADERS)}`);

  for (const model of models) {
    lines.push("");
    lines.push(model);
    const present: GroupStats[] = [];
    for (const tool of VARIANT_ORDER) {
      const g = groups.get(`${model} ${tool}`);
      if (g) {
        present.push(g);
        lines.push(`  ${groupRow(g)}`);
      }
    }
    // Headline gap vs the `edit` baseline (or the first present lane), one line
    // per other lane. Map each model to its native tool to read the RL effect.
    const base = present.find((g) => g.tool === "edit") ?? present[0];
    for (const g of present) {
      if (!base || g === base) {
        continue;
      }
      const dOk = (base.correct / base.n - g.correct / g.n) * 100;
      const dOut = base.outTokens / base.n - g.outTokens / g.n;
      const dCost = base.cost / base.n - g.cost / g.n;
      lines.push(
        `    Δ (${base.tool}−${g.tool}): pass ${signed(dOk, 0)}pp, ` +
          `out ${signed(Math.round(dOut), 0)} tok, cost ${signed(dCost, 4)}$`
      );
    }
    for (const g of present) {
      const line = errorLine(g);
      if (line) {
        lines.push(line);
      }
    }
  }

  lines.push("");
  lines.push(
    "pass%  - final file matches golden",
    "1st%   - first tool call applied cleanly",
    "calls  - mean tool calls",
    "err    - mean failed calls",
    "clean% - share of applied edits that matched exactly, no fuzzy rescue (edit only)"
  );
  lines.push(...renderPerTask(results));
  return lines.join("\n");
}

export async function loadResults(
  pathArg: string | undefined
): Promise<readonly RunResult[]> {
  let file = pathArg;
  if (file && !file.endsWith(".jsonl")) {
    file = join(file, "results.jsonl");
  }
  if (!file) {
    const entries = await readdir(RUNS_DIR, { withFileTypes: true }).catch(
      () => []
    );
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    const latest = dirs.at(-1);
    if (!latest) {
      throw new Error(
        `No run directories under ${RUNS_DIR}. Pass a results.jsonl path.`
      );
    }
    file = join(RUNS_DIR, latest, "results.jsonl");
  }
  const text = await Bun.file(file).text();
  return text
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line) as RunResult);
}

if (import.meta.main) {
  const results = await loadResults(process.argv[2]);
  console.log(renderReport(results));
}
