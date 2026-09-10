import { readdirSync, rmSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Paths } from "./Paths";
import { Sweeper } from "./Sweeper";

// The parent id names a directory; a call id is opaque provider data, hashed rather than trusted as a segment.
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
// A call id arrives off the wire: bound what gets hashed.
const MAX_CALL_ID_LENGTH = 4096;

const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

// Must stay outside pi's sessions root, which `SessionRegistry` globs as the session catalogue.
function dir(): string {
  return join(Paths.pimHomeDir(), "subagents");
}

function pathFor(parentSessionId: string, callId: string): string | null {
  if (
    !ID_RE.test(parentSessionId) ||
    callId.length === 0 ||
    callId.length > MAX_CALL_ID_LENGTH
  ) {
    return null;
  }
  return join(
    dir(),
    parentSessionId,
    `${Bun.SHA256.hash(callId, "hex")}.jsonl`
  );
}

// Create the log empty with explicit modes: a file pi creates takes the process umask.
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

// Expire a parent's children together by newest mtime, or a long run loses its earlier subagents.
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

function installSweeper(): void {
  Sweeper.install({ cleanup, intervalMs: SWEEP_INTERVAL_MS });
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
