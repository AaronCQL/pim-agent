import { readdir, rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { SessionMeta } from "../session/SessionMeta";
import type { SessionRegistry } from "../session/SessionRegistry";

export type StoredEntry = {
  readonly scope: string;
  readonly path: string;
  readonly size: number;
  readonly modifiedAt: number;
};

export type SweepPolicy = {
  /** Session ids with a session file; an empty set disables the orphan rule. */
  readonly alive: ReadonlySet<string>;
  readonly archived: ReadonlySet<string>;
  readonly now: number;
  readonly budgetBytes?: number;
  readonly graceMs?: number;
};

export type SweepResult = {
  readonly removed: number;
  readonly freedBytes: number;
};

const BUDGET_BYTES = 5 * 1024 * 1024 * 1024;
const GRACE_MS = 24 * 60 * 60 * 1000;
const INTERVAL_MS = 60 * 60 * 1000;

/**
 * Files younger than the grace period are untouched and uncounted. Of the
 * rest: orphans and files bigger than the whole budget go, then the oldest —
 * archived sessions first — until the remainder fits the budget.
 */
function doomed(
  entries: readonly StoredEntry[],
  policy: SweepPolicy
): readonly StoredEntry[] {
  const budget = policy.budgetBytes ?? BUDGET_BYTES;
  const cutoff = policy.now - (policy.graceMs ?? GRACE_MS);
  const trustsListing = policy.alive.size > 0;
  const removed: StoredEntry[] = [];
  const kept: StoredEntry[] = [];
  for (const entry of entries) {
    if (entry.modifiedAt >= cutoff) {
      continue;
    }
    const orphaned = trustsListing && !policy.alive.has(entry.scope);
    (orphaned || entry.size > budget ? removed : kept).push(entry);
  }

  const rank = (entry: StoredEntry) =>
    policy.archived.has(entry.scope) ? 0 : 1;
  kept.sort((a, b) => rank(a) - rank(b) || a.modifiedAt - b.modifiedAt);
  let total = kept.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of kept) {
    if (total <= budget) {
      break;
    }
    removed.push(entry);
    total -= entry.size;
  }
  return removed;
}

async function scan(root: string): Promise<readonly StoredEntry[]> {
  const scopes = await readdir(root, { withFileTypes: true }).catch(() => []);
  const perScope = await Promise.all(
    scopes
      .filter((scope) => scope.isDirectory())
      .map(async (scope) => {
        const dir = join(root, scope.name);
        const names = await readdir(dir).catch(() => []);
        const entries = await Promise.all(
          names.map(async (name) => {
            const path = join(dir, name);
            const st = await stat(path).catch(() => undefined);
            return st?.isFile()
              ? {
                  scope: scope.name,
                  path,
                  size: st.size,
                  modifiedAt: st.mtimeMs,
                }
              : undefined;
          })
        );
        return entries.filter((entry) => entry !== undefined);
      })
  );
  return perScope.flat();
}

async function sweep(root: string, policy: SweepPolicy): Promise<SweepResult> {
  const victims = doomed(await scan(root), policy);
  await Promise.all(victims.map((entry) => rm(entry.path, { force: true })));
  const scopes = new Set(victims.map((entry) => entry.scope));
  await Promise.all(
    [...scopes].map((scope) => rmdir(join(root, scope)).catch(() => {}))
  );
  return {
    removed: victims.length,
    freedBytes: victims.reduce((sum, entry) => sum + entry.size, 0),
  };
}

/** Sweeps now and hourly; returns the stop function. */
function install(deps: {
  readonly root: string;
  readonly registry: SessionRegistry;
  readonly meta: SessionMeta;
}): () => void {
  let running: Promise<void> | undefined;
  const run = (): void => {
    running ??= (async () => {
      const [summaries, entries] = await Promise.all([
        deps.registry.list(),
        deps.meta.sessions(),
      ]);
      await sweep(deps.root, {
        alive: new Set(summaries.map((summary) => summary.sessionId)),
        archived: new Set(
          [...entries]
            .filter(([, entry]) => entry.archived === true)
            .map(([sessionId]) => sessionId)
        ),
        now: Date.now(),
      });
    })()
      .catch((error: unknown) => {
        process.stderr.write(
          `attachment sweep failed: ${error instanceof Error ? error.message : String(error)}\n`
        );
      })
      .finally(() => {
        running = undefined;
      });
  };
  run();
  const timer = setInterval(run, INTERVAL_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
  };
}

export const AttachmentSweep = {
  BUDGET_BYTES,
  GRACE_MS,
  doomed,
  sweep,
  install,
};
