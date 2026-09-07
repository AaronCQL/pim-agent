import { rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { Git } from "./Git";
import { PimVersion } from "./PimVersion";
import { Supervisor, type Install } from "./Supervisor";

/** Relative to `packages/web`, which is the vite root `build:web` cds into. */
const STAGING_OUT_DIR = "dist/staging";

type ClientDirs = {
  readonly staging: string;
  readonly client: string;
  readonly previous: string;
};

/** A spawned command, or filesystem work — never both, so a plan reads as argv. */
export type UpdateStep =
  | {
      readonly label: string;
      readonly command: ReadonlyArray<string>;
      readonly cwd: string | undefined;
    }
  | { readonly label: string; readonly act: () => Promise<void> };

export type UpdateSkip = { readonly label: string; readonly reason: string };

export type UpdatePlan = {
  readonly steps: ReadonlyArray<UpdateStep>;
  readonly skipped: ReadonlyArray<UpdateSkip>;
};

export type UpdateFacts = {
  readonly at: Install;
  readonly packageName: string;
  /** A dev checkout with no uncommitted changes; irrelevant to a prod install. */
  readonly cleanTree: boolean;
  /** The newest published release, or undefined when the registry was silent. */
  readonly latest: string | undefined;
};

export type UpdateOutcome = {
  readonly ok: boolean;
  readonly from: string;
  /** Re-read from disk after the steps ran, never the version that was asked for. */
  readonly to: string;
  readonly skipped: ReadonlyArray<UpdateSkip>;
  readonly error: string | undefined;
};

export type UpdateOptions = {
  readonly onStep?: (label: string) => void | Promise<void>;
};

function clientDirs(packageRoot: string): ClientDirs {
  const dist = join(packageRoot, "packages", "web", "dist");
  return {
    staging: join(dist, "staging"),
    client: join(dist, "client"),
    previous: join(dist, "previous"),
  };
}

/**
 * `vite build` empties its outDir, so building straight into `dist/client`
 * would delete the working bundle before knowing the new one compiles, and a
 * compile error would leave the server serving its 503 build hint with no way
 * back. The build lands beside it and is swapped in only on success;
 * `StaticClient` reads from disk per request, so the swap is what goes live.
 * The bundle it replaces is kept for a manual rollback.
 */
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

function plan(facts: UpdateFacts): UpdatePlan {
  const steps: UpdateStep[] = [];
  const skipped: UpdateSkip[] = [];
  const { at, packageName, cleanTree, latest } = facts;

  if (at.kind === "dev") {
    if (cleanTree) {
      steps.push({
        label: "git pull",
        command: ["git", "pull", "--ff-only"],
        cwd: at.packageRoot,
      });
    } else {
      // An operator editing the checkout asked for their own edits to take
      // effect. Pulling under uncommitted work — never mind stashing it — is
      // worse than doing less, so the pull is dropped and reported.
      skipped.push({
        label: "git pull",
        reason: "the working tree has uncommitted changes",
      });
    }
    steps.push({
      label: "bun install",
      command: ["bun", "install"],
      cwd: at.packageRoot,
    });
    steps.push({
      label: "build the web client",
      command: ["bun", "run", "build:web", "--", "--outDir", STAGING_OUT_DIR],
      cwd: at.packageRoot,
    });
    steps.push({
      label: "swap in the new web client",
      act: () => swapClient(at.packageRoot),
    });
    return { steps, skipped };
  }

  if (latest === undefined) {
    // The operator asked for a restart as much as an update, and the installed
    // version still runs: report the miss and let the rest of the run stand.
    skipped.push({
      label: "install",
      reason: "the npm registry could not be reached",
    });
  } else {
    // The exact version, never `@latest`: a tag cannot be reported truthfully.
    steps.push({
      label: `install ${packageName}@${latest}`,
      command: ["bun", "install", "-g", `${packageName}@${latest}`],
      // No cwd: a global install must not adopt the tree it is replacing.
      cwd: undefined,
    });
  }
  // Nothing to build in prod: the npm tarball ships the client prebuilt.
  return { steps, skipped };
}

async function gather(): Promise<UpdateFacts> {
  const at = await Supervisor.detectInstall();
  const [packageName, cleanTree, latest] = await Promise.all([
    PimVersion.name(),
    at.kind === "dev"
      ? Git.fetchStatus(at.packageRoot).then((git) => git.dirtyCount === 0)
      : Promise.resolve(true),
    at.kind === "prod" ? PimVersion.latest() : Promise.resolve(undefined),
  ]);
  return { at, packageName, cleanTree, latest };
}

/** Never restarts or exits: the caller owns that, and has its own work first. */
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
  const proc = Bun.spawn([...cmd], {
    cwd,
    stdout: "inherit",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(
      `exit ${code}: ${stderr.trim().split("\n").slice(-5).join("\n") || "(no stderr)"}`
    );
  }
}

export const Updater = { plan, run };
