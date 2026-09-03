import { readdirSync, statSync, unlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Paths } from "./Paths";

const SPILL_FILE_RE =
  /^[a-z0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]+$/;

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

let installed = false;

function dir(): string {
  return join(Paths.pimHomeDir(), "cache");
}

async function write(
  prefix: string,
  ext: string,
  data: string | Uint8Array
): Promise<string | null> {
  const cacheDir = dir();
  const path = join(cacheDir, `${prefix}-${Bun.randomUUIDv7()}.${ext}`);
  try {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    await writeFile(path, data, { flag: "wx", mode: 0o600 });
    return path;
  } catch {
    return null;
  }
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

/**
 * Idempotent: registers the full spill-file lifecycle (startup sweep,
 * periodic sweep, and cleanup on exit/termination) once, no matter how many
 * extensions call it. Each tool that writes spills calls this in its setup.
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

export const SpillCache = {
  TTL_MS,
  SWEEP_INTERVAL_MS,
  dir,
  write,
  cleanup,
  installSweeper,
};
