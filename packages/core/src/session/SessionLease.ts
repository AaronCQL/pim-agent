import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, open, stat, unlink, utimes } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";

import { FileWatch } from "../shared/FileWatch";
import { FsErrors } from "../shared/FsErrors";
import { Fs } from "../shared/Fs";
import { Json } from "../shared/Json";

export type LeaseFrontend = "tui" | "daemon";

/** What one holder wrote into `<sessionPath>.lease`. */
export type LeaseRecord = {
  readonly pid: number;
  readonly hostname: string;
  readonly frontend: LeaseFrontend;
  readonly startedAt: number;
};

export type LeaseHandle = {
  release(): Promise<void>;
};

export type AcquireResult =
  | { readonly ok: true; readonly handle: LeaseHandle }
  /** Absent when the holder's file is torn or vanished mid-read. */
  | { readonly ok: false; readonly holder?: LeaseRecord };

export type LeaseOptions = {
  readonly heartbeatMs?: number;
  readonly pollMs?: number;
  readonly timeoutMs?: number;
  /** Called with the current holder each time an acquire is denied and another poll follows. */
  readonly onBlocked?: (holder: LeaseRecord | undefined) => void;
};

const HEARTBEAT_MS = 5_000;
const STALE_MS = 30_000;
const POLL_MS = 250;
const TIMEOUT_MS = 5 * 60_000;
const STEAL_ATTEMPTS = 3;
const STEAL_BACKOFF_MS = 50;

const HOST = hostname();

const held = new Set<string>();
let exitHooked = false;

function pathFor(sessionPath: string): string {
  return `${sessionPath}.lease`;
}

function toRecord(value: unknown): LeaseRecord | undefined {
  const raw = Json.asRecord(value);
  if (
    typeof raw?.pid !== "number" ||
    typeof raw.hostname !== "string" ||
    typeof raw.startedAt !== "number" ||
    (raw.frontend !== "tui" && raw.frontend !== "daemon")
  ) {
    return undefined;
  }
  return {
    pid: raw.pid,
    hostname: raw.hostname,
    frontend: raw.frontend,
    startedAt: raw.startedAt,
  };
}

async function recordAt(path: string): Promise<LeaseRecord | undefined> {
  return toRecord(await Fs.readJsonOr<unknown>(path, undefined));
}

/** The current holder, or undefined when the file is absent, torn, or half-written. */
async function read(sessionPath: string): Promise<LeaseRecord | undefined> {
  return await recordAt(pathFor(sessionPath));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM is someone else's live process.
    return FsErrors.code(err) !== "ESRCH";
  }
}

/** A holder is stale once its pid is gone, or once it stops heartbeating; never across hosts. */
function isStale(
  record: LeaseRecord,
  mtimeMs: number,
  now = Date.now()
): boolean {
  if (record.hostname !== HOST) {
    return false;
  }
  return !isAlive(record.pid) || now - mtimeMs > STALE_MS;
}

/** Whether this very process wrote that record — the one holder allowed to release it. */
function isOurs(record: LeaseRecord | undefined): boolean {
  return record?.pid === process.pid && record.hostname === HOST;
}

async function stealable(
  path: string,
  record: LeaseRecord | undefined
): Promise<boolean> {
  const mtimeMs = await stat(path).then(
    (stats) => stats.mtimeMs,
    () => undefined
  );
  if (mtimeMs === undefined) {
    return true;
  }
  // A torn file is a holder mid-write until it stops being refreshed.
  return record === undefined
    ? Date.now() - mtimeMs > STALE_MS
    : isStale(record, mtimeMs);
}

async function claim(
  path: string,
  frontend: LeaseFrontend
): Promise<LeaseRecord | undefined> {
  const record: LeaseRecord = {
    pid: process.pid,
    hostname: HOST,
    frontend,
    startedAt: Date.now(),
  };
  const file = await open(path, "wx").catch((err: unknown) => {
    if (FsErrors.code(err) === "EEXIST") {
      return undefined;
    }
    // The session's directory is pi's to create, and a lease can precede the file it guards.
    if (FsErrors.code(err) === "ENOENT") {
      return mkdir(dirname(path), { recursive: true }).then(() =>
        open(path, "wx")
      );
    }
    throw err;
  });
  if (file === undefined) {
    return undefined;
  }
  try {
    await file.writeFile(`${JSON.stringify(record)}\n`);
  } finally {
    await file.close();
  }
  return record;
}

function hookExit(): void {
  if (exitHooked) {
    return;
  }
  exitHooked = true;
  process.on("exit", () => {
    for (const path of held) {
      try {
        if (isOurs(toRecord(Json.tryParseJson(readFileSync(path, "utf8"))))) {
          unlinkSync(path);
        }
      } catch {}
    }
  });
}

function handleFor(path: string, options: LeaseOptions): LeaseHandle {
  held.add(path);
  hookExit();
  // Bump mtime rather than rewrite: a rename would clobber whoever holds the file next.
  const beat = setInterval(() => {
    const now = new Date();
    void utimes(path, now, now).catch(() => undefined);
  }, options.heartbeatMs ?? HEARTBEAT_MS);
  beat.unref?.();

  let released = false;
  return {
    release: async (): Promise<void> => {
      if (released) {
        return;
      }
      released = true;
      clearInterval(beat);
      held.delete(path);
      if (isOurs(await recordAt(path))) {
        await unlink(path).catch(() => undefined);
      }
    },
  };
}

/** Create-exclusive, stealing only a lease whose holder is provably gone. */
async function acquire(
  sessionPath: string,
  frontend: LeaseFrontend,
  options: LeaseOptions = {}
): Promise<AcquireResult> {
  const path = pathFor(sessionPath);
  for (let attempt = 0; ; attempt++) {
    if (await claim(path, frontend)) {
      return { ok: true, handle: handleFor(path, options) };
    }
    const holder = await recordAt(path);
    if (attempt >= STEAL_ATTEMPTS || !(await stealable(path, holder))) {
      return holder === undefined ? { ok: false } : { ok: false, holder };
    }
    await unlink(path).catch(() => undefined);
    await Bun.sleep(STEAL_BACKOFF_MS);
  }
}

/** Polls until the lease is free, the deadline passes, or the holder is stealable. */
async function waitFor(
  sessionPath: string,
  frontend: LeaseFrontend,
  options: LeaseOptions = {}
): Promise<AcquireResult> {
  const deadline = Date.now() + (options.timeoutMs ?? TIMEOUT_MS);
  while (true) {
    const result = await acquire(sessionPath, frontend, options);
    if (result.ok || Date.now() >= deadline) {
      return result;
    }
    options.onBlocked?.(result.holder);
    await Bun.sleep(options.pollMs ?? POLL_MS);
  }
}

function denial(result: { readonly holder?: LeaseRecord }): string {
  const holder = result.holder;
  const who =
    holder === undefined
      ? "another process"
      : `${holder.frontend} (pid ${holder.pid})`;
  return `Session is busy: ${who} still holds its turn lease.`;
}

/** The only safe way to take a lease: waits for it, and always gives it back. */
async function hold<T>(
  sessionPath: string,
  frontend: LeaseFrontend,
  work: () => Promise<T>,
  options: LeaseOptions = {}
): Promise<T> {
  const result = await waitFor(sessionPath, frontend, options);
  if (!result.ok) {
    throw new Error(denial(result));
  }
  try {
    return await work();
  } finally {
    await result.handle.release();
  }
}

/** Fires whenever the lease appears, changes hands, or is released. */
function watch(sessionPath: string, onChange: () => void): () => void {
  return FileWatch.file(pathFor(sessionPath), onChange);
}

/** A turn lease over one session file, held as a sibling `<sessionPath>.lease`. */
export const SessionLease = {
  pathFor,
  read,
  acquire,
  hold,
  waitFor,
  watch,
  isStale,
  isOurs,
};
