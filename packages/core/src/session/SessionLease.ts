import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, open, unlink, utimes } from "node:fs/promises";
import { dirname } from "node:path";

import { FileWatch } from "../shared/FileWatch";
import { FsErrors } from "../shared/FsErrors";
import { Fs } from "../shared/Fs";
import { Json } from "../shared/Json";
import { Proc, type ProcOwner } from "../shared/Proc";
import { Shutdown } from "../shared/Shutdown";

export type LeaseFrontend = "tui" | "daemon";

export type LeaseRecord = ProcOwner & {
  readonly frontend: LeaseFrontend;
  readonly startedAt: number;
};

export type LeaseHandle = {
  release(): Promise<void>;
};

export type AcquireResult =
  | { readonly ok: true; readonly handle: LeaseHandle }
  /** Absent when the lease file is torn or vanished mid-read. */
  | { readonly ok: false; readonly holder?: LeaseRecord };

export type LeaseHolder = {
  readonly record?: LeaseRecord;
};

export type LeaseOptions = {
  readonly heartbeatMs?: number;
  readonly pollMs?: number;
  readonly timeoutMs?: number;
  /** Called on each denied attempt that will be retried. */
  readonly onBlocked?: (holder: LeaseRecord | undefined) => void;
};

const HEARTBEAT_MS = 5_000;
const STALE_MS = 30_000;
const POLL_MS = 250;
const TIMEOUT_MS = 5 * 60_000;
const STEAL_ATTEMPTS = 3;
const STEAL_BACKOFF_MS = 50;

const held = new Set<string>();

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

/** Undefined when the file is absent or unparseable. */
async function read(sessionPath: string): Promise<LeaseRecord | undefined> {
  return await recordAt(pathFor(sessionPath));
}

/** Stale when its pid is gone or it stopped heartbeating. Never stale across hosts. */
function isStale(record: LeaseRecord, mtimeMs: number): boolean {
  if (!Proc.isLocal(record)) {
    return false;
  }
  return !Proc.isAlive(record.pid) || Date.now() - mtimeMs > STALE_MS;
}

function isOurs(record: LeaseRecord | undefined): boolean {
  return Proc.isSelf(record);
}

/**
 * The lease's holder, unless `acquire` would steal it: absent, or left by a dead
 * or silent process on this host. `record` is absent while the file is torn.
 */
async function holder(sessionPath: string): Promise<LeaseHolder | undefined> {
  const file = await open(pathFor(sessionPath)).catch(() => undefined);
  if (file === undefined) {
    return undefined;
  }
  try {
    const [stats, text] = await Promise.all([
      file.stat(),
      file.readFile("utf8"),
    ]);
    const record = toRecord(Json.tryParseJson(text));
    // A torn file may be mid-write; it holds until its heartbeat stops.
    if (record === undefined) {
      return Date.now() - stats.mtimeMs > STALE_MS ? undefined : {};
    }
    return isStale(record, stats.mtimeMs) ? undefined : { record };
  } finally {
    await file.close();
  }
}

async function claim(
  path: string,
  frontend: LeaseFrontend
): Promise<LeaseRecord | undefined> {
  const record: LeaseRecord = {
    ...Proc.self(),
    frontend,
    startedAt: Date.now(),
  };
  const file = await open(path, "wx").catch((err: unknown) => {
    if (FsErrors.code(err) === "EEXIST") {
      return undefined;
    }
    // The lease can be taken before pi creates the session directory.
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

function unlinkHeld(): void {
  for (const path of held) {
    try {
      if (isOurs(toRecord(Json.tryParseJson(readFileSync(path, "utf8"))))) {
        unlinkSync(path);
      }
    } catch {}
  }
}

function handleFor(path: string, options: LeaseOptions): LeaseHandle {
  held.add(path);
  Shutdown.onExit(unlinkHeld);
  // Touch mtime only; rewriting could clobber the next holder's file.
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

/** Create-exclusive; steals only a stale lease. */
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
    const current = await holder(sessionPath);
    if (current !== undefined || attempt >= STEAL_ATTEMPTS) {
      return current?.record === undefined
        ? { ok: false }
        : { ok: false, holder: current.record };
    }
    await unlink(path).catch(() => undefined);
    await Bun.sleep(STEAL_BACKOFF_MS);
  }
}

/** Polls `acquire` until it succeeds or the timeout passes. */
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

/** Runs `work` under the lease, always releasing it. Throws if it cannot be taken. */
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

function watch(sessionPath: string, onChange: () => void): () => void {
  return FileWatch.file(pathFor(sessionPath), onChange);
}

/** A turn lease over one session file, stored at `<sessionPath>.lease`. */
export const SessionLease = {
  pathFor,
  read,
  acquire,
  hold,
  waitFor,
  watch,
  holder,
  isOurs,
};
