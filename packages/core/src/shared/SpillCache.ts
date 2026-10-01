import { readdirSync, statSync, unlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FsErrors } from "./FsErrors";
import { Paths } from "./Paths";
import { Sweeper } from "./Sweeper";

// Matches UUIDv7-named and SHA-256-named spills.
const SPILL_FILE_RE =
  /^[a-z0-9]+-(?:[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9a-f]{64})\.[a-z0-9]+$/;

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

function dir(): string {
  return join(Paths.pimHomeDir(), "cache");
}

/** Keeps an existing file of the same name; returns its path either way. Null on failure. */
async function writeNamed(
  name: string,
  data: string | Uint8Array
): Promise<string | null> {
  const cacheDir = dir();
  const path = join(cacheDir, name);
  try {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    await writeFile(path, data, { flag: "wx", mode: 0o600 });
    return path;
  } catch (error) {
    return FsErrors.code(error) === "EEXIST" ? path : null;
  }
}

async function write(
  prefix: string,
  ext: string,
  data: string | Uint8Array
): Promise<string | null> {
  return writeNamed(`${prefix}-${Bun.randomUUIDv7()}.${ext}`, data);
}

function cleanup(cacheDir = dir(), now = Date.now()): void {
  let entries: string[];
  try {
    entries = readdirSync(cacheDir);
  } catch {
    return;
  }

  const cutoff = now - TTL_MS;
  for (const name of entries) {
    if (!SPILL_FILE_RE.test(name)) {
      continue;
    }
    const path = join(cacheDir, name);
    try {
      const metadata = statSync(path);
      if (metadata.isFile() && metadata.mtimeMs < cutoff) {
        unlinkSync(path);
      }
    } catch {}
  }
}

function installSweeper(): void {
  Sweeper.install({ cleanup, intervalMs: SWEEP_INTERVAL_MS });
}

export const SpillCache = {
  TTL_MS,
  dir,
  write,
  writeNamed,
  cleanup,
  installSweeper,
};
