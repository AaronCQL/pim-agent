#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Variant } from "./harness";
import { killActiveRuns, loadTasks, resolveVariant, runOne } from "./harness";
import { renderReport } from "./report";
import type { RunOptions, Task, VariantId } from "./types";

const RUNS_DIR = join(import.meta.dir, "runs");
const ALL_VARIANTS: readonly VariantId[] = ["edit", "apply_patch", "hashline"];
// hashline is opt-in: it needs an external extension installed, so a bare run
// must not select it (and abort). List it in --tools to run it.
const DEFAULT_VARIANTS: readonly VariantId[] = ["edit", "apply_patch"];
// `pi install npm:pi-hashline-edit` lands the extension here; override the
// location (a dir or a direct index.ts) with --hashline-path.
const DEFAULT_HASHLINE_INDEX = join(
  homedir(),
  ".pi",
  "agent",
  "npm",
  "node_modules",
  "pi-hashline-edit",
  "index.ts"
);

type Args = {
  readonly models: readonly string[];
  readonly tools: readonly VariantId[];
  readonly reps: number;
  readonly taskIds: readonly string[];
  readonly tags: readonly string[];
  readonly inline: boolean;
  readonly allowRead: boolean;
  readonly concurrency: number;
  readonly timeoutMs: number;
  readonly out: string;
  readonly keepWork: boolean;
  readonly hashlinePath: string;
};

function csv(value: string | undefined): readonly string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function readConfiguredModels(): readonly string[] {
  const path = join(homedir(), ".pi", "agent", "models.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  // Tolerate trailing commas (the config is JSONC-ish).
  const cleaned = raw.replace(/,(\s*[}\]])/g, "$1");
  let parsed: {
    readonly providers?: Record<
      string,
      { readonly models?: readonly { readonly id?: string }[] }
    >;
  };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  const models: string[] = [];
  for (const [provider, config] of Object.entries(parsed.providers ?? {})) {
    for (const model of config.models ?? []) {
      if (model.id) {
        models.push(`${provider}/${model.id}`);
      }
    }
  }
  return models;
}

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      bools.add(key);
    } else {
      flags.set(key, next);
      i += 1;
    }
  }

  const stamp = new Date()
    .toISOString()
    .replace(/\..+$/, "")
    .replaceAll(":", "-");
  const tools = (csv(flags.get("tools")) as VariantId[]).filter((t) =>
    ALL_VARIANTS.includes(t)
  );
  const models = csv(flags.get("models"));
  // Default mirrors production: the model reads via the lane's read tool.
  // --inline pastes the file into the prompt and drops read (raw-format
  // isolation); incompatible with hashline, which is filtered out in main().
  const inline = bools.has("inline");
  const rawHashline = flags.get("hashline-path");
  const hashlinePath = rawHashline
    ? rawHashline.endsWith(".ts")
      ? rawHashline
      : join(rawHashline, "index.ts")
    : DEFAULT_HASHLINE_INDEX;

  return {
    models: models.length > 0 ? models : readConfiguredModels(),
    tools: tools.length > 0 ? tools : DEFAULT_VARIANTS,
    reps: Number(flags.get("reps") ?? 3),
    taskIds: csv(flags.get("tasks") ?? flags.get("task")),
    tags: csv(flags.get("tags") ?? flags.get("tag")),
    inline,
    allowRead: !inline,
    concurrency: Number(flags.get("concurrency") ?? 1),
    timeoutMs: Number(flags.get("timeout") ?? 120) * 1000,
    out: flags.get("out") ?? join(RUNS_DIR, stamp),
    keepWork: !bools.has("no-keep"),
    hashlinePath,
  };
}

function selectTasks(tasks: readonly Task[], args: Args): readonly Task[] {
  return tasks.filter((task) => {
    if (args.taskIds.length > 0 && !args.taskIds.includes(task.id)) {
      return false;
    }
    if (args.tags.length > 0 && !args.tags.includes(task.tag)) {
      return false;
    }
    return true;
  });
}

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
  return results;
}

type Job = {
  readonly task: Task;
  readonly variant: Variant;
  readonly model: string;
  readonly rep: number;
};

async function main(): Promise<void> {
  // Tear down in-flight pim/pi processes on Ctrl-C instead of orphaning them.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      killActiveRuns();
      process.exit(130);
    });
  }

  const args = parseArgs(process.argv.slice(2));
  if (args.models.length === 0) {
    console.error(
      "No models. Pass --models provider/id[,provider/id] (none found in ~/.pi/agent/models.json)."
    );
    process.exit(1);
  }

  const allTasks = await loadTasks();
  const tasks = selectTasks(allTasks, args);
  if (tasks.length === 0) {
    console.error("No tasks matched the filters.");
    process.exit(1);
  }

  // hashline is a coupled read+edit system: its edits reference hash anchors
  // that only its own read emits, so --inline (no read) cannot drive it.
  let selected = args.tools;
  if (args.inline && selected.includes("hashline")) {
    console.warn(
      "Skipping the hashline lane under --inline: its edits need the read tool's hash anchors."
    );
    selected = selected.filter((id) => id !== "hashline");
  }
  if (selected.length === 0) {
    console.error("No editing lanes left to run.");
    process.exit(1);
  }
  const variants = selected.map((id) => resolveVariant(id, args.hashlinePath));

  if (
    variants.some((v) => v.id === "hashline") &&
    !(await Bun.file(args.hashlinePath).exists())
  ) {
    console.error(
      `hashline extension not found at ${args.hashlinePath}.\n` +
        "Install it with: pi install npm:pi-hashline-edit\n" +
        "or pass --hashline-path <dir-or-index.ts> pointing at a checkout."
    );
    process.exit(1);
  }

  const jobs: Job[] = [];
  for (const task of tasks) {
    for (const variant of variants) {
      for (const model of args.models) {
        for (let rep = 1; rep <= args.reps; rep += 1) {
          jobs.push({ task, variant, model, rep });
        }
      }
    }
  }

  await mkdir(args.out, { recursive: true });
  const resultsPath = join(args.out, "results.jsonl");
  const options: RunOptions = {
    workRoot: join(args.out, "work"),
    timeoutMs: args.timeoutMs,
    inline: args.inline,
    allowRead: args.allowRead,
    keepWork: args.keepWork,
  };
  await Bun.write(
    join(args.out, "config.json"),
    JSON.stringify(
      {
        ...args,
        tools: selected,
        tasks: tasks.map((t) => t.id),
        jobs: jobs.length,
      },
      null,
      2
    )
  );

  console.log(
    `Running ${jobs.length} jobs: ${tasks.length} task(s) × ${variants.length} lane(s) × ` +
      `${args.models.length} model(s) × ${args.reps} rep(s), concurrency ${args.concurrency}`
  );
  console.log(`Output: ${args.out}\n`);

  let done = 0;
  let writeChain: Promise<void> = Promise.resolve();
  const results = await mapPool(jobs, args.concurrency, async (job) => {
    const result = await runOne(
      job.task,
      job.variant,
      job.model,
      job.rep,
      options
    );
    done += 1;
    const status = result.finalCorrect ? "pass" : "fail";
    const cost = result.costUsd > 0 ? ` $${result.costUsd.toFixed(4)}` : "";
    console.log(
      `[${String(done).padStart(3)}/${jobs.length}] ${status} ${job.task.id.padEnd(13)} ` +
        `${job.variant.id.padEnd(11)} ${job.model}  r${job.rep}  ` +
        `calls=${result.editToolCalls} err=${result.editToolErrors} out=${result.outputTokens}${cost} ` +
        `(${result.wallMs}ms)${result.timedOut ? " TIMEOUT" : ""}`
    );
    const line = `${JSON.stringify(result)}\n`;
    writeChain = writeChain.then(() => appendFile(resultsPath, line));
    return result;
  });
  await writeChain;

  const report = renderReport(results);
  console.log(`\n${report}`);
  await Bun.write(join(args.out, "summary.txt"), report);
  console.log(`\nResults: ${resultsPath}`);
}

await main();
