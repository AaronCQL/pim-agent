import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  ErrorKind,
  RunOptions,
  RunResult,
  Task,
  VariantId,
} from "./types";

// benchmarks/edit -> repo root.
const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const TASKS_DIR = join(import.meta.dir, "tasks");

// A resolved editing lane: how to launch pim for it and how to read its events.
// Decouples the benchmark lane (VariantId) from the registered tool name, since
// hashline's edit tool is registered as `edit` (same as pim's) yet is a wholly
// separate read+edit system. See types.ts `VariantId`.
export type Variant = {
  readonly id: VariantId;
  // The registered tool name to allowlist and to filter tool_execution_end on.
  readonly toolName: string;
  // Extension entry points to load (besides pim's read, handled via bundlesRead).
  readonly extPaths: readonly string[];
  // The extension registers its own `read`; don't add pim's, and always expose
  // read regardless of --inline (its edits need the read's hash anchors).
  readonly bundlesRead: boolean;
  // --inline (paste file, drop read) makes sense for this lane.
  readonly supportsInline: boolean;
  // Pim's edit has a 9-strategy fuzzy matcher feeding `resolvedEdits[].strategy`
  // (the clean% signal). apply_patch and hashline have no such thing.
  readonly hasFuzzyMatcher: boolean;
};

function pimExtension(dir: string): string {
  return join(REPO_ROOT, "src", "extensions", dir, "index.ts");
}

export function resolveVariant(id: VariantId, hashlineIndex: string): Variant {
  switch (id) {
    case "edit":
      return {
        id,
        toolName: "edit",
        extPaths: [pimExtension("edit")],
        bundlesRead: false,
        supportsInline: true,
        hasFuzzyMatcher: true,
      };
    case "apply_patch":
      return {
        id,
        toolName: "apply_patch",
        extPaths: [pimExtension("apply-patch")],
        bundlesRead: false,
        supportsInline: true,
        hasFuzzyMatcher: false,
      };
    case "hashline":
      return {
        id,
        // pi-hashline-edit registers its edit tool as `edit` and its read as
        // `read` from the same index.ts; the edit references the read's anchors.
        toolName: "edit",
        extPaths: [hashlineIndex],
        bundlesRead: true,
        supportsInline: false,
        hasFuzzyMatcher: false,
      };
  }
}

// Minimal typed accessors over parsed JSON events.
function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// Live pim subprocesses, so an interrupted orchestrator (Ctrl-C) tears them down
// instead of orphaning them. SIGTERM lets pim forward the signal to its pi child.
const activeProcs = new Set<ReturnType<typeof Bun.spawn>>();

export function killActiveRuns(): void {
  for (const proc of activeProcs) {
    try {
      proc.kill("SIGTERM");
    } catch {
      // best effort
    }
  }
}

export async function loadTasks(): Promise<readonly Task[]> {
  const entries = await readdir(TASKS_DIR, { withFileTypes: true });
  const tasks: Task[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = join(TASKS_DIR, entry.name);
    const manifest = (await Bun.file(join(dir, "task.json")).json()) as {
      readonly id: string;
      readonly tag: string;
      readonly title: string;
      readonly files: readonly string[];
      readonly instruction: string;
    };
    tasks.push({ ...manifest, dir });
  }
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}

async function buildPrompt(task: Task, inline: boolean): Promise<string> {
  const fileList = task.files.map((file) => `\`${file}\``).join(", ");
  const blocks: string[] = [
    task.instruction,
    "",
    `Make this change to the file(s) ${fileList} in the current directory, ` +
      "then stop. Do not ask questions.",
  ];
  if (inline) {
    for (const file of task.files) {
      const content = await Bun.file(join(task.dir, "before", file)).text();
      blocks.push(
        "",
        `The file \`${file}\` currently contains exactly:`,
        "",
        "```",
        content,
        "```"
      );
    }
  }
  return blocks.join("\n");
}

function modelSlug(model: string): string {
  return model.replaceAll(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function pimArgs(
  variant: Variant,
  model: string,
  allowRead: boolean,
  prompt: string
): readonly string[] {
  const extensions = [...variant.extPaths];
  const tools = [variant.toolName];
  if (variant.bundlesRead) {
    // The lane's own read ships in the same extension and is mandatory (its
    // edits reference the read's anchors), so always expose it.
    tools.push("read");
  } else if (allowRead) {
    extensions.push(pimExtension("read"));
    tools.push("read");
  }
  const allowlist = tools.join(",");

  const args = [
    "--print",
    "--mode",
    "json",
    "--no-session",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    // Deterministic surface: no extension discovery, no built-ins. Only the
    // explicitly-loaded extension(s) register tools, so exactly one editing
    // tool exists and the model-based edit/apply_patch swap cannot fire.
    "--no-extensions",
    "--no-builtin-tools",
  ];
  for (const ext of extensions) {
    args.push("--extension", ext);
  }
  args.push("--tools", allowlist, "--model", model, "--", prompt);
  return args;
}

function resultText(result: unknown): string {
  const content = asObject(result)?.["content"];
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => asString(asObject(block)?.["text"]) ?? "")
    .join("\n");
}

function classifyError(variant: Variant, text: string): ErrorKind {
  const t = text.toLowerCase();
  if (variant.id === "hashline") {
    // pi-hashline-edit tags its failures with bracketed E_* codes.
    if (t.includes("e_stale_anchor") || t.includes("stale anchor")) {
      return "stale_anchor";
    }
    if (t.includes("e_multi_match") || t.includes("ambiguous")) {
      return "ambiguous";
    }
    if (t.includes("e_range_oob") || t.includes("does not exist")) {
      return "not_found";
    }
    if (t.includes("e_bad_op")) {
      return "wrong_op";
    }
    if (
      t.includes("hash") ||
      t.includes("must be") ||
      t.includes("requires") ||
      t.includes("invalid")
    ) {
      return "invalid_args";
    }
    if (t.includes("file not found")) {
      return "not_found";
    }
    return "other";
  }
  if (variant.id === "edit") {
    if (t.includes("overlapping")) {
      return "overlap";
    }
    if (t.includes("no-op") || t.includes("already contains")) {
      return "noop";
    }
    if (t.includes("identical")) {
      return "identical";
    }
    if (t.includes("multiple")) {
      return "ambiguous";
    }
    if (t.includes("find") || t.includes("match") || t.includes("closest")) {
      return "not_found";
    }
    if (
      t.includes("required") ||
      t.includes("expected") ||
      t.includes("must")
    ) {
      return "invalid_args";
    }
    return "other";
  }
  if (t.includes("context") || t.includes("expected lines")) {
    return "context_mismatch";
  }
  if (t.includes("multiple regions")) {
    return "ambiguous";
  }
  if (
    t.includes("already exists") ||
    t.includes("does not exist") ||
    t.includes("use ***")
  ) {
    return "wrong_op";
  }
  if (t.includes("no files were modified")) {
    return "noop";
  }
  if (
    t.includes("patch") ||
    t.includes("hunk") ||
    t.includes("invalid") ||
    t.includes("unexpected") ||
    t.includes("begin") ||
    t.includes("end of")
  ) {
    return "malformed_patch";
  }
  return "other";
}

function normalize(content: string): string {
  return content.replaceAll("\r\n", "\n").replace(/[\r\n]+$/, "");
}

async function compareToGolden(task: Task, workDir: string): Promise<boolean> {
  for (const file of task.files) {
    const goldenPath = join(task.dir, "after", file);
    const actualPath = join(workDir, file);
    const golden = normalize(await Bun.file(goldenPath).text());
    let actual: string;
    try {
      actual = normalize(await Bun.file(actualPath).text());
    } catch {
      return false;
    }
    if (actual !== golden) {
      return false;
    }
  }
  return true;
}

async function seedWorkDir(task: Task, workDir: string): Promise<void> {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  for (const file of task.files) {
    const content = await Bun.file(join(task.dir, "before", file)).text();
    const dest = join(workDir, file);
    await mkdir(dirname(dest), { recursive: true });
    await Bun.write(dest, content);
  }
}

export async function runOne(
  task: Task,
  variant: Variant,
  model: string,
  rep: number,
  options: RunOptions
): Promise<RunResult> {
  const workDir = join(
    options.workRoot,
    `${task.id}__${variant.id}__${modelSlug(model)}__r${rep}`
  );
  await seedWorkDir(task, workDir);

  const prompt = await buildPrompt(task, options.inline);
  const args = pimArgs(variant, model, options.allowRead, prompt);

  // Accumulators parsed from the JSONL event stream.
  let editToolCalls = 0;
  let editToolErrors = 0;
  let firstCallValid: boolean | null = null;
  const errorKinds: ErrorKind[] = [];
  const strategies: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let costUsd = 0;
  const keptEvents: unknown[] = [];

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      return;
    }
    let event: Record<string, unknown> | undefined;
    try {
      event = asObject(JSON.parse(trimmed));
    } catch {
      return;
    }
    if (!event) {
      return;
    }
    const type = asString(event["type"]);

    if (type === "message_end") {
      const message = asObject(event["message"]);
      if (asString(message?.["role"]) !== "assistant") {
        return;
      }
      const usage = asObject(message?.["usage"]);
      if (!usage) {
        return;
      }
      keptEvents.push(event);
      inputTokens += asNumber(usage["input"]) + asNumber(usage["cacheRead"]);
      outputTokens += asNumber(usage["output"]);
      totalTokens += asNumber(usage["totalTokens"]);
      costUsd += asNumber(asObject(usage["cost"])?.["total"]);
      return;
    }

    if (type === "tool_execution_end") {
      keptEvents.push(event);
      if (asString(event["toolName"]) !== variant.toolName) {
        return;
      }
      editToolCalls += 1;
      const isError = event["isError"] === true;
      if (firstCallValid === null) {
        firstCallValid = !isError;
      }
      if (isError) {
        editToolErrors += 1;
        errorKinds.push(classifyError(variant, resultText(event["result"])));
        return;
      }
      if (variant.hasFuzzyMatcher) {
        const details = asObject(asObject(event["result"])?.["details"]);
        const resolved = details?.["resolvedEdits"];
        if (Array.isArray(resolved)) {
          for (const item of resolved) {
            const strategy = asString(asObject(item)?.["strategy"]);
            if (strategy) {
              strategies.push(strategy);
            }
          }
        }
      }
    }
  };

  const started = Bun.nanoseconds();
  const proc = Bun.spawn(["pim", ...args], {
    cwd: workDir,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  activeProcs.add(proc);

  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  let timedOut = false;
  // SIGTERM, not SIGKILL: pim is a launcher that forwards the signal to the pi
  // grandchild, which holds the same stdout pipe. Killing only pim would orphan
  // pi and leave the read loop blocked on a pipe that never reaches EOF.
  // reader.cancel() then unblocks the loop without waiting for that EOF.
  const killTimer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGTERM");
    } catch {
      // process may have already exited
    }
    reader.cancel().catch(() => undefined);
  }, options.timeoutMs);

  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
  } catch {
    // reader.cancel() on timeout rejects the pending read; fall through to teardown.
  }
  if (buffer) {
    handleLine(buffer);
  }

  const exitCode = await proc.exited;
  clearTimeout(killTimer);
  activeProcs.delete(proc);
  const wallMs = Math.round((Bun.nanoseconds() - started) / 1e6);

  const finalCorrect = await compareToGolden(task, workDir);

  const result: RunResult = {
    taskId: task.id,
    tag: task.tag,
    tool: variant.id,
    model,
    rep,
    finalCorrect,
    editToolCalls,
    editToolErrors,
    firstCallValid,
    errorKinds,
    strategies,
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd,
    wallMs,
    timedOut,
    exitCode,
  };

  // Leave a self-contained record next to the edited file for inspection.
  await Bun.write(
    join(workDir, "run.jsonl"),
    keptEvents.map((event) => JSON.stringify(event)).join("\n")
  );
  await Bun.write(
    join(workDir, "result.json"),
    JSON.stringify(result, null, 2)
  );

  if (!options.keepWork) {
    await rm(workDir, { recursive: true, force: true });
  }

  return result;
}
