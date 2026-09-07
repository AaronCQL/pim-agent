import { readdirSync, rmSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Paths } from "./Paths";

/**
 * The charset a pi session id and a provider tool call id share. Both become
 * path segments here, so anything outside it is refused rather than escaped:
 * a path built from an id is only safe if the id cannot be a path.
 */
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

let installed = false;

/**
 * Deliberately not under pi's sessions root: `SessionRegistry` lists the
 * catalogue by globbing that root, and a subagent run is not a session anyone
 * may resume.
 */
function dir(): string {
  return join(Paths.pimHomeDir(), "subagents");
}

/** Null when either id is not usable as a path segment. */
function pathFor(parentSessionId: string, callId: string): string | null {
  if (!ID_RE.test(parentSessionId) || !ID_RE.test(callId)) {
    return null;
  }
  return join(dir(), parentSessionId, `${callId}.jsonl`);
}

/**
 * Creates the child log empty so pi appends to a file with our modes rather
 * than creating one with the process umask. A child log holds whatever the
 * child read.
 */
async function create(
  parentSessionId: string,
  callId: string
): Promise<string | null> {
  const path = pathFor(parentSessionId, callId);
  if (!path) {
    return null;
  }
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, "", { flag: "wx", mode: 0o600 });
    return path;
  } catch {
    return null;
  }
}

/**
 * Expires a parent's children together, by the newest mtime under its
 * directory, so a long-running parent never has its earlier subagents swept
 * out from under it.
 */
function cleanup(root = dir(), now = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }

  const cutoff = now - TTL_MS;
  for (const name of names) {
    if (!ID_RE.test(name)) {
      continue;
    }
    const parentDir = join(root, name);
    try {
      if (!statSync(parentDir).isDirectory()) {
        continue;
      }
      if (newestMtime(parentDir) >= cutoff) {
        continue;
      }
      rmSync(parentDir, { recursive: true, force: true });
    } catch {}
  }
}

function newestMtime(parentDir: string): number {
  let newest = statSync(parentDir).mtimeMs;
  for (const name of readdirSync(parentDir)) {
    try {
      newest = Math.max(newest, statSync(join(parentDir, name)).mtimeMs);
    } catch {}
  }
  return newest;
}

/**
 * Idempotent: registers the retention lifecycle (startup sweep, periodic
 * sweep, and cleanup on exit/termination) once, however many times it is
 * called.
 */
function installSweeper(): void {
  if (installed) {
    return;
  }
  installed = true;

  cleanup();
  setInterval(() => {
    cleanup();
  }, SWEEP_INTERVAL_MS).unref?.();
  process.once("exit", () => {
    cleanup();
  });

  // Signal-induced termination skips the "exit" handler, so sweep here too.
  // Re-raise after our once-handler is gone so the default termination still
  // happens — merely registering a signal listener otherwise suppresses it.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.once(sig, () => {
      try {
        cleanup();
      } catch {}
      process.kill(process.pid, sig);
    });
  }
}

export const SubagentLogs = {
  TTL_MS,
  SWEEP_INTERVAL_MS,
  dir,
  pathFor,
  create,
  cleanup,
  installSweeper,
};
