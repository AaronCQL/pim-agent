/**
 * Every quality gate this repo has, and the only place their arguments live.
 *
 *   bun scripts/check.ts                 # the per-commit set
 *   bun scripts/check.ts pack            # a subset, including the CI-only ones
 *   bun scripts/check.ts agent --changed # ...with flags for the test runner
 *
 * Three rules earn this a script instead of a `&&` chain in package.json.
 *
 * `oxlint --fix` and `oxfmt` rewrite the same files, so they run first and in
 * that order — a reader racing them typechecks a half-written tree, and the
 * formatter has to see what oxlint fixed. Everything after them only reads,
 * so it runs at once.
 *
 * A bare run is the set an agent pays for after every commit, so a task worth
 * less than its seconds there is `ciOnly` and has to be named to run. CI names
 * them; see `.github/workflows/ci.yml`.
 *
 * Under `CI` the two rewriting tasks stop rewriting: nobody is there to commit
 * a repaired file, and the fix dies with the runner, so a green job would be
 * the only trace that the tree was ever wrong. There they report and fail
 * instead, which is the same information at the only time it can be acted on.
 *
 * A task that passes prints nothing: on a green run the exit code is the whole
 * report. The exceptions are the two things worth tokens — a task that failed,
 * and a file that got rewritten.
 */
import { resolve } from "node:path";

/** Set by every CI provider worth the name, and by GitHub Actions. */
const CI = Bun.env.CI !== undefined && Bun.env.CI !== "false";

type Task = {
  readonly name: string;
  readonly argv: readonly string[];
  /** Rewrites files: runs before the readers, and never beside one. */
  readonly mutates?: boolean;
  /** Takes `bun test` flags, and must never legitimately run zero tests. */
  readonly tests?: boolean;
  /** Too slow to earn a place in the per-commit set: run it by name. */
  readonly ciOnly?: boolean;
  /**
   * Run before `argv`; its stdout is the list of files `argv` would rewrite,
   * and an empty list skips `argv` entirely. Exists because oxfmt's
   * `--list-different` and `--write` are mutually exclusive, so naming the
   * damage and repairing it are two passes — and the clean case, which is
   * nearly every case, is then the cheap pass alone with no file touched.
   */
  readonly listArgv?: readonly string[];
};

/** Everything `format` owns, and nothing it merely happens to be able to parse. */
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
    // Without `--max-warnings=0` oxlint exits 0 on warnings, so a chain of
    // these stays green while printing complaints nobody has to act on.
    // Without `--fix` it reports the same problems and exits non-zero, which
    // is what CI wants: a diagnostic it can print, not a repair it discards.
    argv: ["oxlint", ".", ...(CI ? [] : ["--fix"]), "--max-warnings=0"],
    mutates: true,
  },
  {
    name: "format",
    // Named globs, never a bare `.`: oxfmt will happily walk the whole tree,
    // and it formats Markdown and JSON too. Under `proseWrap: never` that
    // folds a `> [!TIP]` callout onto one line, which is not a restyling but
    // a break — GitHub stops rendering it. Benchmark result JSON is data and
    // is not ours to reflow either. So the scope is the source we own.
    listArgv: ["oxfmt", "--list-different", ...FORMAT_PATHS],
    argv: ["oxfmt", ...FORMAT_PATHS],
    mutates: true,
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
      // Overrides `bunfig.toml`, which keeps these tests out of a bare
      // `bun test` for the reason above. A CLI list replaces the config's
      // rather than adding to it, so this says "ignore nothing" in the only
      // vocabulary the flag has: bun never walks `node_modules` anyway.
      "--path-ignore-patterns=**/node_modules/**",
      "--isolate",
      "--only-failures",
      "--parallel",
    ],
    tests: true,
  },
  {
    name: "pack",
    // Packs a real tarball, and `prepack` makes that a full Vite build — the
    // only thing anywhere that runs Rolldown, UnoCSS and the Solid plugin, so
    // it is what catches a stale `index.html` entry, an unresolvable lazy
    // `import()`, or a moved stylesheet. All of that is a publish-time
    // failure, not a per-commit one, hence `ciOnly`. Also stays out of the
    // `agent` glob, which is why it is its own task at all.
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

async function spawn(argv: readonly string[]): Promise<Output> {
  const child = Bun.spawn([...argv], {
    cwd: ROOT,
    // oxlint, oxfmt and tsgo are `node_modules/.bin` shims that only `bun run`
    // puts on PATH, and going through `bun run` would re-print every command
    // as it starts.
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
  return { stdout, stderr, exitCode };
}

async function run(task: Task, forwarded: readonly string[]): Promise<boolean> {
  if (task.listArgv !== undefined) {
    return await runTwoPhase(task, task.listArgv);
  }
  const { stdout, stderr, exitCode } = await spawn([
    ...task.argv,
    ...(task.tests ? forwarded : []),
  ]);

  // A path filter that stops matching anything reports as a pass. Only trust
  // that on an unnarrowed run: `--changed` legitimately finds nothing.
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

/**
 * Name the damage, then repair it — and say what got repaired, since a file
 * rewritten under an agent's feet is worth its tokens. Under `CI` the second
 * phase is skipped and the naming alone is the verdict.
 */
async function runTwoPhase(
  task: Task,
  listArgv: readonly string[]
): Promise<boolean> {
  // Exit 1 is oxfmt's way of saying "these differ", which is the whole point
  // of asking. Only a higher code is a formatter that could not read the tree.
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
