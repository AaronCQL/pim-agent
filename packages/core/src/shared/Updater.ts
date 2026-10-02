import { rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { Git } from "./Git";
import { PimVersion } from "./PimVersion";
import { Proc } from "./Proc";
import { Supervisor, type Install } from "./Supervisor";

const STAGING = "staging";

// Relative to `packages/web`, the vite root.
const STAGING_OUT_DIR = `dist/${STAGING}`;

type ClientDirs = {
  readonly staging: string;
  readonly client: string;
  readonly previous: string;
};

export type UpdateStep =
  | {
      readonly label: string;
      readonly command: ReadonlyArray<string>;
      readonly cwd: string | undefined;
    }
  | { readonly label: string; readonly act: () => Promise<void> };

/** `blocking` means the update did less than asked. */
export type UpdateSkip = {
  readonly label: string;
  readonly reason: string;
  readonly blocking: boolean;
};

type UpdatePlan = {
  readonly steps: ReadonlyArray<UpdateStep>;
  readonly skipped: ReadonlyArray<UpdateSkip>;
};

export type UpdateFacts = {
  readonly at: Install;
  readonly packageName: string;
  /** Dev only: no uncommitted changes. */
  readonly cleanTree: boolean;
  /** Dev only: the branch has an upstream. */
  readonly tracked: boolean;
  /** Undefined when the registry could not be reached. */
  readonly latest: string | undefined;
};

export type UpdateOutcome = {
  readonly ok: boolean;
  readonly from: string;
  /** Re-read from disk after the steps ran. */
  readonly to: string;
  readonly skipped: ReadonlyArray<UpdateSkip>;
  readonly error: string | undefined;
};

type UpdateOptions = {
  readonly onStep?: (label: string) => void | Promise<void>;
};

function clientDirs(packageRoot: string): ClientDirs {
  const dist = join(packageRoot, "packages", "web", "dist");
  return {
    staging: join(dist, STAGING),
    client: join(dist, "client"),
    previous: join(dist, "previous"),
  };
}

// `vite build` empties its outDir, so build to staging and swap; a failed build keeps the live bundle.
async function swapClient(packageRoot: string): Promise<void> {
  const dirs = clientDirs(packageRoot);
  await rm(dirs.previous, { recursive: true, force: true });
  await rename(dirs.client, dirs.previous).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  });
  await rename(dirs.staging, dirs.client);
}

function pullBlocker(facts: UpdateFacts): string | undefined {
  if (!facts.tracked) {
    return "this branch has no upstream to pull from";
  }
  return facts.cleanTree
    ? undefined
    : "the working tree has uncommitted changes";
}

function plan(facts: UpdateFacts): UpdatePlan {
  const steps: UpdateStep[] = [];
  const skipped: UpdateSkip[] = [];
  const { at, packageName, latest } = facts;

  if (at.kind === "dev") {
    const blocked = pullBlocker(facts);
    if (blocked === undefined) {
      steps.push({
        label: "git pull",
        command: ["git", "pull", "--ff-only"],
        cwd: at.packageRoot,
      });
    } else {
      skipped.push({
        label: "git pull",
        reason: blocked,
        blocking: false,
      });
    }
    steps.push({
      label: "bun install",
      command: ["bun", "install"],
      cwd: at.packageRoot,
    });
    steps.push({
      label: "build the web client",
      command: ["bun", "run", "web:build", "--", "--outDir", STAGING_OUT_DIR],
      cwd: at.packageRoot,
    });
    steps.push({
      label: "swap in the new web client",
      act: () => swapClient(at.packageRoot),
    });
    return { steps, skipped };
  }

  if (latest === undefined) {
    skipped.push({
      label: "install",
      reason: "the npm registry could not be reached",
      blocking: true,
    });
  } else {
    // Exact version, not `@latest`, so the reported version is accurate.
    steps.push({
      label: `install ${packageName}@${latest}`,
      command: ["bun", "install", "-g", `${packageName}@${latest}`],
      // No cwd: the global install must not run inside the tree it replaces.
      cwd: undefined,
    });
  }
  return { steps, skipped };
}

async function gather(): Promise<UpdateFacts> {
  const at = await Supervisor.detectInstall();
  const [packageName, cleanTree, tracked, latest] = await Promise.all([
    PimVersion.name(),
    at.kind === "dev"
      ? Git.fetchStatus(at.packageRoot).then((git) => git.dirtyCount === 0)
      : Promise.resolve(true),
    at.kind === "dev"
      ? Git.upstreamOf(at.packageRoot).then(
          (upstream) => upstream !== undefined
        )
      : Promise.resolve(true),
    at.kind === "prod" ? PimVersion.latest() : Promise.resolve(undefined),
  ]);
  return { at, packageName, cleanTree, tracked, latest };
}

/** Never restarts or exits; that's the caller's job. */
async function run(options: UpdateOptions = {}): Promise<UpdateOutcome> {
  const from = await PimVersion.current();
  const { steps, skipped } = plan(await gather());
  for (const step of steps) {
    await options.onStep?.(step.label);
    try {
      if ("command" in step) {
        await runOrThrow(step.command, step.cwd);
      } else {
        await step.act();
      }
    } catch (err) {
      return {
        ok: false,
        from,
        to: await PimVersion.current(),
        skipped,
        error: `${step.label}: ${(err as Error).message}`,
      };
    }
  }
  return {
    ok: true,
    from,
    to: await PimVersion.current(),
    skipped,
    error: undefined,
  };
}

async function runOrThrow(
  cmd: ReadonlyArray<string>,
  cwd: string | undefined
): Promise<void> {
  const { code, stderr } = await Proc.run(cmd, { cwd, stdout: "inherit" });
  if (code !== 0) {
    throw new Error(
      `exit ${code}: ${stderr.trim().split("\n").slice(-5).join("\n") || "(no stderr)"}`
    );
  }
}

export const Updater = { plan, run };
