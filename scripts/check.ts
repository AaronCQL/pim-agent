/**
 * Every quality gate, and the only place their arguments live.
 *
 *   bun scripts/check.ts                 # the per-commit set
 *   bun scripts/check.ts pack            # a subset, including CI-only tasks
 *   bun scripts/check.ts agent --changed # flags go to the test runner
 *
 * Mutating tasks (lint, then format) run first, in order; readers then run in parallel.
 * Under `CI`, lint and format only report. A green run prints one line.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CI = Bun.env.CI !== undefined && Bun.env.CI !== "false";

// `agent` and `web` run together; full parallelism starves CI runners.
const TEST_PARALLEL = CI ? "--parallel=1" : "--parallel";

// Above the suites' own 15-20s waits, so those report what they waited on.
const TEST_TIMEOUT = "--timeout=30000";

type Task = {
  readonly name: string;
  readonly argv: readonly string[];
  /** Rewrites files: runs before the readers, never beside one. */
  readonly mutates?: boolean;
  /** Takes `bun test` flags; running zero tests is a failure. */
  readonly tests?: boolean;
  /** Skipped unless named. */
  readonly ciOnly?: boolean;
  /** Lists the files `argv` would rewrite; an empty list skips `argv`. */
  readonly listArgv?: readonly string[];
};

// Never `.`: oxfmt would also reflow Markdown (breaking callouts) and data JSON.
const FORMAT_PATHS = [
  "packages/**/*.{ts,tsx}",
  "bin/**/*.ts",
  "scripts/**/*.ts",
  "package.json",
  "tsconfig.json",
  ".oxlintrc.json",
  ".oxfmtrc.json",
];

const TASKS: readonly Task[] = [
  {
    name: "lint",
    argv: ["oxlint", ".", ...(CI ? [] : ["--fix"]), "--max-warnings=0"],
    mutates: true,
  },
  {
    name: "format",
    listArgv: ["oxfmt", "--list-different", ...FORMAT_PATHS],
    argv: ["oxfmt", ...FORMAT_PATHS],
    mutates: true,
  },
  { name: "typecheck", argv: ["tsc", "--noEmit"] },
  {
    name: "agent",
    argv: [
      "bun",
      "test",
      "./packages",
      "./scripts/brand",
      "--path-ignore-patterns=**/packages/web/**",
      "--path-ignore-patterns=**/packaging.test.ts",
      "--only-failures",
      TEST_PARALLEL,
      TEST_TIMEOUT,
      "--no-isolate",
    ],
    tests: true,
  },
  {
    name: "web",
    // Needs `--isolate`: happy-dom globals and pi's module state leak between files.
    argv: [
      "bun",
      "test",
      "./packages/web",
      "--isolate",
      "--only-failures",
      TEST_PARALLEL,
      TEST_TIMEOUT,
    ],
    tests: true,
  },
  {
    name: "pack",
    // Packs a real tarball, which runs the full Vite build via `prepack`.
    argv: [
      "bun",
      "test",
      "./packages/core/src/packaging.test.ts",
      "--only-failures",
    ],
    tests: true,
    ciOnly: true,
  },
];

const ROOT = resolve(import.meta.dir, "..");
const MAX_LINES = 120;
const TAIL_LINES = 5;

const USAGE = `usage: bun scripts/check.ts [task…] [test flags…]

tasks:  ${TASKS.map((task) => (task.ciOnly ? `${task.name}*` : task.name)).join(" ")}
        * CI-only: slow, and skipped unless you name it
flags:  forwarded to the test tasks — bun scripts/check.ts agent --changed`;

function select(args: readonly string[]): {
  readonly tasks: readonly Task[];
  readonly forwarded: readonly string[];
} {
  // The first flag ends the task names (`-t pattern` has a bare word after it).
  const firstFlag = args.findIndex((arg) => arg.startsWith("-"));
  const names = firstFlag === -1 ? args : args.slice(0, firstFlag);
  const forwarded = firstFlag === -1 ? [] : args.slice(firstFlag);

  if (forwarded.includes("--help") || forwarded.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  const unknown = names.filter(
    (name) => !TASKS.some((task) => task.name === name)
  );
  if (unknown.length > 0) {
    process.stderr.write(`unknown task: ${unknown.join(" ")}\n\n${USAGE}\n`);
    process.exit(2);
  }

  const tasks =
    names.length === 0
      ? TASKS.filter((task) => !task.ciOnly)
      : TASKS.filter((task) => names.includes(task.name));
  if (forwarded.length > 0 && !tasks.some((task) => task.tests)) {
    process.stderr.write(
      `${forwarded.join(" ")}: only the test tasks take flags\n\n${USAGE}\n`
    );
    process.exit(2);
  }
  return { tasks, forwarded };
}

type Output = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

/** The test runners' `TMPDIR`, removed after they exit: pi writes there from unawaited refreshes. */
let testTmp: string | undefined;

async function spawn(
  argv: readonly string[],
  env: Record<string, string> = {}
): Promise<Output> {
  const child = Bun.spawn([...argv], {
    cwd: ROOT,
    // Puts the `node_modules/.bin` shims on PATH without `bun run`'s echo.
    env: {
      ...process.env,
      PATH: `${ROOT}/node_modules/.bin:${process.env.PATH}`,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function run(task: Task, forwarded: readonly string[]): Promise<boolean> {
  if (task.listArgv !== undefined) {
    return await runTwoPhase(task, task.listArgv);
  }
  const { stdout, stderr, exitCode } = await spawn(
    [...task.argv, ...(task.tests ? forwarded : [])],
    task.tests && testTmp !== undefined ? { TMPDIR: testTmp } : {}
  );

  // A path filter matching nothing passes; only flag it when no flags narrow the run.
  const ranNothing =
    task.tests && forwarded.length === 0 && !/Ran [1-9]\d* tests/.test(stderr);

  if (exitCode === 0 && !ranNothing) {
    return true;
  }

  report(
    ranNothing
      ? `${task.name} ran no tests — its path filters match nothing`
      : `${task.name} failed (exit ${String(exitCode)})`,
    `${stdout}${stderr}`,
    task.name
  );
  return false;
}

/** Lists the files to rewrite, then rewrites them (under `CI`, only lists and fails). */
async function runTwoPhase(
  task: Task,
  listArgv: readonly string[]
): Promise<boolean> {
  // Exit 1 means "files differ"; only higher codes are errors.
  const listed = await spawn(listArgv);
  if (listed.exitCode > 1) {
    report(
      `${task.name} failed (exit ${String(listed.exitCode)})`,
      `${listed.stdout}${listed.stderr}`,
      task.name
    );
    return false;
  }

  const files = listed.stdout.trim();
  if (files.length === 0) {
    return true;
  }

  const count = files.split("\n").length;
  const plural = `file${count === 1 ? "" : "s"}`;
  if (CI) {
    report(
      `${task.name} would rewrite ${String(count)} ${plural} — run \`bun run check\` and commit the result`,
      files,
      task.name
    );
    return false;
  }

  const fixed = await spawn(task.argv);
  if (fixed.exitCode !== 0) {
    report(
      `${task.name} failed (exit ${String(fixed.exitCode)})`,
      `${fixed.stdout}${fixed.stderr}`,
      task.name
    );
    return false;
  }

  report(`${task.name} rewrote ${String(count)} ${plural}`, files, task.name);
  return true;
}

function report(headline: string, body: string, rerun: string): void {
  const lines = body
    .replace(/\n+$/, "")
    .split("\n")
    .filter((line) => !/^(::(end)?group::|\(pass\) |\s*$)/.test(line));
  // Keep the head and the tail (where the runner prints its summary).
  const shown =
    lines.length <= MAX_LINES
      ? lines
      : [
          ...lines.slice(0, MAX_LINES - TAIL_LINES),
          `… ${String(lines.length - MAX_LINES)} more lines: bun scripts/check.ts ${rerun}`,
          ...lines.slice(-TAIL_LINES),
        ];
  process.stderr.write(`\n── ${headline} ──\n${shown.join("\n")}\n`);
}

const { tasks, forwarded } = select(Bun.argv.slice(2));

const started = Bun.nanoseconds();
if (tasks.some((task) => task.tests)) {
  testTmp = await mkdtemp(join(tmpdir(), "pim-check-"));
}
let ok = true;
for (const task of tasks.filter((task) => task.mutates)) {
  ok = (await run(task, forwarded)) && ok;
}
const readers = await Promise.all(
  tasks.filter((task) => !task.mutates).map((task) => run(task, forwarded))
);
ok = ok && readers.every(Boolean);
if (testTmp !== undefined) {
  await rm(testTmp, { recursive: true, force: true });
}

const elapsed = (Bun.nanoseconds() - started) / 1e9;
process.stdout.write(
  `${ok ? "✓" : "✗"} ${tasks.map((task) => task.name).join(", ")} in ${elapsed.toFixed(1)}s\n`
);
process.exit(ok ? 0 : 1);
