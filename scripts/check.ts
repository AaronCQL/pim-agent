/**
 * Every quality gate this repo has, and the only place their arguments live.
 *
 *   bun scripts/check.ts                 # all of it
 *   bun scripts/check.ts agent web pack  # a subset
 *   bun scripts/check.ts agent --changed # ...with flags for the test runner
 *
 * Two rules earn this a script instead of a `&&` chain in package.json.
 *
 * `oxlint --fix` and `prettier --write` rewrite the same files, so they run
 * first and in that order — a reader racing them typechecks a half-written
 * tree, and prettier has to see what oxlint fixed. Everything after them only
 * reads, so it runs at once.
 *
 * A task that passes prints nothing: on a green run the exit code is the whole
 * report. The exceptions are the two things worth tokens — a task that failed,
 * and a file that got rewritten.
 */
import { resolve } from "node:path";

type Task = {
  readonly name: string;
  readonly argv: readonly string[];
  /** Rewrites files: runs before the readers, and never beside one. */
  readonly mutates?: boolean;
  /** Takes `bun test` flags, and must never legitimately run zero tests. */
  readonly tests?: boolean;
  /** Its output on success is the list of files it rewrote, so print it. */
  readonly reportsChanges?: boolean;
};

const TASKS: readonly Task[] = [
  {
    name: "lint",
    // Without `--max-warnings=0` oxlint exits 0 on warnings, so a chain of
    // these stays green while printing complaints nobody has to act on.
    argv: ["oxlint", ".", "--fix", "--max-warnings=0"],
    mutates: true,
  },
  {
    name: "format",
    argv: [
      "prettier",
      "--write",
      "--list-different",
      "package.json",
      "tsconfig.json",
      ".oxlintrc.json",
      ".prettierrc.json",
      "packages/**/*.{ts,tsx}",
      "bin/**/*.ts",
      "scripts/**/*.ts",
    ],
    mutates: true,
    reportsChanges: true,
  },
  { name: "typecheck", argv: ["tsgo", "--noEmit"] },
  {
    name: "agent",
    argv: [
      "bun",
      "test",
      "./packages",
      "--path-ignore-patterns=**/packages/web/**",
      "--path-ignore-patterns=**/packaging.test.ts",
      "--only-failures",
      "--parallel",
      "--no-isolate",
    ],
    tests: true,
  },
  {
    name: "web",
    // `--conditions=browser` is why this cannot share a process with `agent`:
    // under the default `node` condition `solid-js`/`@solidjs/web` resolve to
    // the SSR build, whose `template` throws on sight.
    argv: [
      "bun",
      "test",
      "./packages/web",
      "--conditions=browser",
      "--isolate",
      "--only-failures",
      "--parallel",
    ],
    tests: true,
  },
  {
    name: "pack",
    // Packs a real tarball, so it is slow and stays out of the `agent` glob.
    argv: [
      "bun",
      "test",
      "./packages/core/src/packaging.test.ts",
      "--only-failures",
    ],
    tests: true,
  },
];

const ROOT = resolve(import.meta.dir, "..");
const MAX_LINES = 120;
const TAIL_LINES = 5;

const USAGE = `usage: bun scripts/check.ts [task…] [test flags…]

tasks:  ${TASKS.map((task) => task.name).join(" ")}   (default: all)
flags:  forwarded to the test tasks — bun scripts/check.ts agent --changed`;

function select(args: readonly string[]): {
  readonly tasks: readonly Task[];
  readonly forwarded: readonly string[];
} {
  // A selector is a bare word and a flag is not, but `-t pattern` puts a bare
  // word after a flag — so the first flag ends the selectors and everything
  // from there is the test runner's.
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
      ? TASKS
      : TASKS.filter((task) => names.includes(task.name));
  if (forwarded.length > 0 && !tasks.some((task) => task.tests)) {
    process.stderr.write(
      `${forwarded.join(" ")}: only the test tasks take flags\n\n${USAGE}\n`
    );
    process.exit(2);
  }
  return { tasks, forwarded };
}

async function run(task: Task, forwarded: readonly string[]): Promise<boolean> {
  const child = Bun.spawn([...task.argv, ...(task.tests ? forwarded : [])], {
    cwd: ROOT,
    // oxlint, prettier and tsgo are `node_modules/.bin` shims that only `bun
    // run` puts on PATH, and going through `bun run` would re-print every
    // command as it starts.
    env: {
      ...process.env,
      PATH: `${ROOT}/node_modules/.bin:${process.env.PATH}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  // A path filter that stops matching anything reports as a pass. Only trust
  // that on an unnarrowed run: `--changed` legitimately finds nothing.
  const ranNothing =
    task.tests && forwarded.length === 0 && !/Ran [1-9]\d* tests/.test(stderr);

  if (exitCode === 0 && !ranNothing) {
    if (task.reportsChanges && stdout.trim().length > 0) {
      const count = stdout.trim().split("\n").length;
      report(
        `${task.name} rewrote ${String(count)} file${count === 1 ? "" : "s"}`,
        stdout,
        task.name
      );
    }
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

function report(headline: string, body: string, rerun: string): void {
  const lines = body.replace(/\n+$/, "").split("\n");
  // Everything broken at once is not worth 2000 lines. Keep the first
  // failures and the tail, which is where the runner says how many there
  // were, and point at the command that prints the rest.
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

let ok = true;
for (const task of tasks.filter((task) => task.mutates)) {
  ok = (await run(task, forwarded)) && ok;
}
const readers = await Promise.all(
  tasks.filter((task) => !task.mutates).map((task) => run(task, forwarded))
);

process.exit(ok && readers.every(Boolean) ? 0 : 1);
