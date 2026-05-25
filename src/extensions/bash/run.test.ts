import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASH_SPILL_TTL_MS,
  cleanupOldBashSpillFiles,
  killAllActiveBashGroups,
  pimCacheDir,
  runBashCommand,
} from "./run";
import {
  DRAIN_GRACE_MS,
  KILL_GRACE_MS,
  STREAM_HEAD_BYTES,
  STREAM_TAIL_BYTES,
} from "./schema";

let previousPimHomeDir: string | undefined;
let testPimHomeDir: string | undefined;

beforeAll(async () => {
  previousPimHomeDir = process.env.PIM_HOME_DIR;
  testPimHomeDir = await mkdtemp(join(tmpdir(), "pim-bash-home-"));
  process.env.PIM_HOME_DIR = testPimHomeDir;
});

afterAll(async () => {
  if (previousPimHomeDir === undefined) {
    delete process.env.PIM_HOME_DIR;
  } else {
    process.env.PIM_HOME_DIR = previousPimHomeDir;
  }
  if (testPimHomeDir) {
    await rm(testPimHomeDir, { recursive: true, force: true });
  }
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await Bun.file(path).exists()) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForNoProcess(
  marker: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const probe = Bun.spawnSync({ cmd: ["pgrep", "-f", marker] });
    if (probe.exitCode !== 0) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Process still running for marker ${marker}`);
    }
    await Bun.sleep(25);
  }
}

describe("runBashCommand (integration)", () => {
  test("captures stdout from a successful command", async () => {
    const r = await runBashCommand(
      "echo hello",
      5000,
      undefined,
      process.cwd()
    );
    expect(r.exitCode).toBe(0);
    expect(r.aborted).toBe(false);
    expect(r.timedOut).toBe(false);
    expect(r.stdout.text.trim()).toBe("hello");
    expect(r.stderr.totalBytes).toBe(0);
  });

  test("captures stderr and non-zero exit", async () => {
    const r = await runBashCommand(
      "echo oops 1>&2; exit 3",
      5000,
      undefined,
      process.cwd()
    );
    expect(r.exitCode).toBe(3);
    expect(r.stderr.text.trim()).toBe("oops");
  });

  test("respects cwd", async () => {
    const r = await runBashCommand("pwd", 5000, undefined, "/tmp");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.text.trim()).toBe("/tmp");
  });

  test("times out and reports timedOut", async () => {
    const r = await runBashCommand("sleep 5", 25, undefined, process.cwd());
    expect(r.timedOut).toBe(true);
    expect(r.exitCode === null || r.exitCode !== 0).toBe(true);
  });

  test("aborts when signal fires", async () => {
    const ctrl = new AbortController();
    const promise = runBashCommand("sleep 5", 5000, ctrl.signal, process.cwd());
    ctrl.abort();
    const r = await promise;
    expect(r.aborted).toBe(true);
  });

  test("returns promptly when a backgrounded child inherits the pipe", async () => {
    const startedAt = Date.now();
    const r = await runBashCommand(
      "nohup sleep 47 > /dev/null 2>&1 & disown; echo done",
      5000,
      undefined,
      process.cwd()
    );
    const elapsed = Date.now() - startedAt;
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.stdout.text.trim()).toBe("done");
    expect(elapsed).toBeLessThan(2000);
    // clean up the orphaned sleep so it doesn't linger
    try {
      Bun.spawnSync({ cmd: ["pkill", "-f", "sleep 47"] });
    } catch {}
  });

  test("timeout kills the whole process group", async () => {
    const marker = `pim-test-timeout-${Date.now()}`;
    const startedAt = Date.now();
    const r = await runBashCommand(
      `bash -c ${shellQuote(`exec -a ${marker} sleep 60`)}`,
      50,
      undefined,
      process.cwd()
    );
    const elapsed = Date.now() - startedAt;
    expect(r.timedOut).toBe(true);
    expect(r.exitCode === null || r.exitCode !== 0).toBe(true);
    expect(elapsed).toBeLessThan(KILL_GRACE_MS + 2000);
    await waitForNoProcess(marker, KILL_GRACE_MS + 500);
  });

  test("does not crash on timeout while drains still hold readers", async () => {
    // Regression: stream.cancel() on a locked stream rejects (Bun throws
    // synchronously). Drains run fire-and-forget, so when a quiet command
    // times out (no output → drain blocked on read), the finally hits
    // cancel before drain has released. Unhandled rejection would crash Bun.
    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => rejections.push(err);
    process.on("unhandledRejection", onRejection);
    try {
      const r = await runBashCommand("sleep 5", 25, undefined, process.cwd());
      expect(r.timedOut).toBe(true);
      await Bun.sleep(25);
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  test("bounded drain returns even when a daemon escapes our process group", async () => {
    // A child that calls setsid itself leaves our pgid and survives killGroup.
    // If it keeps the pipe open, drain would block forever; the DRAIN_GRACE_MS
    // bound forces us to return anyway. The marker lets us clean up after.
    const marker = `pim-test-detached-${Date.now()}`;
    const startedAt = Date.now();
    const r = await runBashCommand(
      `setsid bash -c 'sleep 60; echo ${marker}' > /tmp/${marker}.out 2>&1 < /dev/null & disown; echo done`,
      5000,
      undefined,
      process.cwd()
    );
    const elapsed = Date.now() - startedAt;
    expect(r.exitCode).toBe(0);
    expect(r.stdout.text.trim()).toBe("done");
    expect(elapsed).toBeLessThan(DRAIN_GRACE_MS + 2000);
    try {
      Bun.spawnSync({ cmd: ["pkill", "-f", marker] });
      Bun.spawnSync({ cmd: ["rm", "-f", `/tmp/${marker}.out`] });
    } catch {}
  });

  test("killAllActiveBashGroups sweeps in-flight subtrees", async () => {
    const id = Date.now();
    const marker = `/tmp/pim-test-active-${id}.marker`;
    const ready = `/tmp/pim-test-active-${id}.ready`;
    const processMarker = `pim-test-active-${id}`;
    const pending = runBashCommand(
      `touch ${shellQuote(ready)}; bash -c ${shellQuote(`exec -a ${processMarker} sleep 30`)} && touch ${shellQuote(marker)}`,
      30_000,
      undefined,
      process.cwd()
    );
    try {
      await waitForFile(ready, 1000);
      killAllActiveBashGroups("SIGTERM");
      const result = await pending;
      expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
      await waitForNoProcess(processMarker, KILL_GRACE_MS + 500);
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      Bun.spawnSync({ cmd: ["rm", "-f", marker, ready] });
    }
  });

  test("truncates very large stdout", async () => {
    const totalBytes = STREAM_HEAD_BYTES + STREAM_TAIL_BYTES + 1000;
    const r = await runBashCommand(
      `head -c ${totalBytes} /dev/zero | tr '\\0' 'A'`,
      5000,
      undefined,
      process.cwd()
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.totalBytes).toBe(totalBytes);
    expect(r.stdout.truncated).toBe(true);
    expect(r.stdout.text).toContain("bytes truncated");
  });

  test("spills full stdout to ~/.pim/cache when truncated", async () => {
    const totalBytes = STREAM_HEAD_BYTES + STREAM_TAIL_BYTES + 4096;
    const r = await runBashCommand(
      `head -c ${totalBytes} /dev/zero | tr '\\0' 'A'`,
      5000,
      undefined,
      process.cwd()
    );
    try {
      expect(r.exitCode).toBe(0);
      expect(r.stdout.truncated).toBe(true);
      expect(r.stdout.path).toBeTruthy();
      expect(r.stdout.path!.startsWith(join(pimCacheDir(), "bash-"))).toBe(
        true
      );
      expect(r.stdout.path!.endsWith(".out")).toBe(true);
      const cacheMode = (await stat(pimCacheDir())).mode & 0o777;
      const spillMode = (await stat(r.stdout.path!)).mode & 0o777;
      expect(cacheMode).toBe(0o700);
      expect(spillMode).toBe(0o600);
      const spilled = await Bun.file(r.stdout.path!).text();
      expect(spilled.length).toBe(totalBytes);
      expect(spilled).toBe("A".repeat(totalBytes));
    } finally {
      if (r.stdout.path) {
        try {
          Bun.spawnSync({ cmd: ["rm", "-f", r.stdout.path] });
        } catch {}
      }
    }
  });

  test("omits spill path when stream is empty", async () => {
    const r = await runBashCommand("true", 5000, undefined, process.cwd());
    expect(r.exitCode).toBe(0);
    expect(r.stdout.path).toBeNull();
    expect(r.stderr.path).toBeNull();
  });

  test("cleanupOldBashSpillFiles deletes only expired bash spill files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pim-bash-cleanup-"));
    const now = Date.now();
    const oldSpill = join(
      root,
      "bash-0192ce11-26d5-7dc3-9305-1426de888c5a.out"
    );
    const recentSpill = join(
      root,
      "bash-0192ce11-26d5-7dc4-8894-bc88d506d6ee.err"
    );
    const invalidSpillName = join(root, "bash-not-a-uuid.out");
    const unrelated = join(root, "other-old.out");
    try {
      await writeFile(oldSpill, "old");
      await writeFile(recentSpill, "recent");
      await writeFile(invalidSpillName, "invalid");
      await writeFile(unrelated, "unrelated");
      const oldDate = new Date(now - BASH_SPILL_TTL_MS - 1000);
      await utimes(oldSpill, oldDate, oldDate);
      await utimes(invalidSpillName, oldDate, oldDate);
      await utimes(unrelated, oldDate, oldDate);

      await cleanupOldBashSpillFiles(root, now);

      expect(await Bun.file(oldSpill).exists()).toBe(false);
      expect(await Bun.file(recentSpill).exists()).toBe(true);
      expect(await Bun.file(invalidSpillName).exists()).toBe(true);
      expect(await Bun.file(unrelated).exists()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
