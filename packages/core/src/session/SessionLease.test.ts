import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  type AcquireResult,
  type LeaseRecord,
  SessionLease,
} from "./SessionLease";

const FAST = { pollMs: 5, timeoutMs: 500 };

let tmp: string;
let session: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pim-session-lease-test-"));
  session = join(tmp, "session.jsonl");
  await Bun.write(session, "");
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** A pid that is spawned and reaped, so it is known dead rather than merely unused. */
async function deadPid(): Promise<number> {
  const proc = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
  return proc.pid;
}

async function plant(
  record: Partial<LeaseRecord>,
  ageMs = 0
): Promise<LeaseRecord> {
  const planted: LeaseRecord = {
    pid: process.pid,
    hostname: hostname(),
    frontend: "tui",
    startedAt: Date.now(),
    ...record,
  };
  await writeFile(SessionLease.pathFor(session), JSON.stringify(planted));
  await age(ageMs);
  return planted;
}

async function age(ms: number): Promise<void> {
  const at = new Date(Date.now() - ms);
  await utimes(SessionLease.pathFor(session), at, at);
}

/** Gives back whatever was taken; the test asserts on `ok` itself. */
async function release(result: AcquireResult): Promise<void> {
  if (result.ok) {
    await result.handle.release();
  }
}

async function exists(): Promise<boolean> {
  return await Bun.file(SessionLease.pathFor(session)).exists();
}

describe("SessionLease", () => {
  test("acquires a free session and records the holder", async () => {
    const result = await SessionLease.acquire(session, "daemon");

    expect(result.ok).toBe(true);
    expect(await SessionLease.read(session)).toMatchObject({
      pid: process.pid,
      hostname: hostname(),
      frontend: "daemon",
    });

    await release(result);
    expect(await exists()).toBe(false);
    expect(await SessionLease.read(session)).toBeUndefined();
  });

  test("denies a second acquire while a live holder heartbeats", async () => {
    const first = await SessionLease.acquire(session, "tui");
    const second = await SessionLease.acquire(session, "daemon");

    expect(second.ok).toBe(false);
    expect(second.ok === false && second.holder).toMatchObject({
      pid: process.pid,
      frontend: "tui",
    });

    await release(first);
  });

  test("steals a lease whose holder is dead, or alive but silent", async () => {
    await plant({ pid: await deadPid() });
    const stolen = await SessionLease.acquire(session, "daemon");

    expect(stolen.ok).toBe(true);
    expect(await SessionLease.read(session)).toMatchObject({
      pid: process.pid,
      frontend: "daemon",
    });
    await release(stolen);

    // Pid reuse: the pid is alive, but nothing has bumped mtime for 60s.
    const silent = await plant({ pid: process.pid }, 60_000);
    expect(SessionLease.isStale(silent, Date.now() - 60_000)).toBe(true);

    const reclaimed = await SessionLease.acquire(session, "tui");
    expect(reclaimed.ok).toBe(true);
    await release(reclaimed);
  });

  test("refuses to steal from a live holder that is still beating", async () => {
    const holder = await plant({ pid: process.pid, frontend: "daemon" });

    expect(SessionLease.isStale(holder, Date.now())).toBe(false);
    const denied = await SessionLease.acquire(session, "tui");

    expect(denied.ok).toBe(false);
    expect(denied.ok === false && denied.holder?.frontend).toBe("daemon");
    expect(await SessionLease.read(session)).toMatchObject({
      frontend: "daemon",
    });
  });

  test("hold releases the lease when the work throws", async () => {
    const boom = SessionLease.hold(session, "tui", async () => {
      expect(await exists()).toBe(true);
      throw new Error("turn failed");
    });

    await expect(boom).rejects.toThrow("turn failed");
    expect(await exists()).toBe(false);
  });

  test("leases a session file whose directory does not exist yet", async () => {
    const unborn = join(tmp, "sessions", "nested", "new.jsonl");
    const result = await SessionLease.acquire(unborn, "daemon");

    expect(result.ok).toBe(true);
    expect(await SessionLease.read(unborn)).toMatchObject({
      frontend: "daemon",
    });

    await release(result);
    expect(await Bun.file(SessionLease.pathFor(unborn)).exists()).toBe(false);
  });

  test("waitFor reports the holder to onBlocked before each retry", async () => {
    const holder = await plant({ pid: process.pid, frontend: "daemon" });
    const blocked: (LeaseRecord | undefined)[] = [];

    await SessionLease.waitFor(session, "tui", {
      pollMs: 5,
      timeoutMs: 20,
      onBlocked: (record) => blocked.push(record),
    });

    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked[0]).toEqual(holder);
  });

  test("waitFor gives up at the deadline and reports the holder", async () => {
    await plant({ pid: process.pid, frontend: "daemon" });

    const started = Date.now();
    const result = await SessionLease.waitFor(session, "tui", {
      pollMs: 5,
      timeoutMs: 30,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.holder?.frontend).toBe("daemon");
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
  });

  test("waitFor takes the lease as soon as the holder releases", async () => {
    const first = await SessionLease.acquire(session, "tui");
    const waiting = SessionLease.waitFor(session, "daemon", FAST);

    await release(first);
    const result = await waiting;

    expect(result.ok).toBe(true);
    expect(await SessionLease.read(session)).toMatchObject({
      frontend: "daemon",
    });
    await release(result);
  });

  test("release leaves a lease that was stolen from us alone", async () => {
    const ours = await SessionLease.acquire(session, "tui");
    const thief = await plant({ pid: process.pid + 1, frontend: "daemon" });

    await release(ours);

    expect(await SessionLease.read(session)).toEqual(thief);
  });

  test("tolerates a torn write: unreadable now, stealable once stale", async () => {
    await writeFile(SessionLease.pathFor(session), '{"pid": 12');

    expect(await SessionLease.read(session)).toBeUndefined();
    const denied = await SessionLease.acquire(session, "tui");
    expect(denied.ok).toBe(false);
    expect(denied.ok === false && denied.holder).toBeUndefined();

    await age(60_000);
    const stolen = await SessionLease.acquire(session, "tui");
    expect(stolen.ok).toBe(true);
    await release(stolen);
  });

  test("never steals a lease written by another host", async () => {
    const foreign = await plant(
      { pid: await deadPid(), hostname: "other-box" },
      60_000
    );

    expect(SessionLease.isStale(foreign, 0)).toBe(false);
    const denied = await SessionLease.acquire(session, "tui");

    expect(denied.ok).toBe(false);
    expect(denied.ok === false && denied.holder).toEqual(foreign);
    expect(await SessionLease.read(session)).toEqual(foreign);
  });
});
