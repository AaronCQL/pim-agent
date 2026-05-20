import { describe, expect, test } from "bun:test";
import { killAllActiveBashGroups, runBashCommand } from "./run";
import {
  DRAIN_GRACE_MS,
  KILL_GRACE_MS,
  STREAM_HEAD_BYTES,
  STREAM_TAIL_BYTES,
} from "./schema";

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
    const r = await runBashCommand("sleep 5", 100, undefined, process.cwd());
    expect(r.timedOut).toBe(true);
    expect(r.exitCode === null || r.exitCode !== 0).toBe(true);
  });

  test("aborts when signal fires", async () => {
    const ctrl = new AbortController();
    const promise = runBashCommand("sleep 5", 5000, ctrl.signal, process.cwd());
    setTimeout(() => ctrl.abort(), 50);
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
    const marker = "sleep 41";
    const startedAt = Date.now();
    const r = await runBashCommand(marker, 500, undefined, process.cwd());
    const elapsed = Date.now() - startedAt;
    expect(r.timedOut).toBe(true);
    expect(r.exitCode === null || r.exitCode !== 0).toBe(true);
    expect(elapsed).toBeLessThan(KILL_GRACE_MS + 2000);
    // wait briefly for SIGKILL grace then confirm no stray sleep 41 remains
    await Bun.sleep(KILL_GRACE_MS + 500);
    const probe = Bun.spawnSync({ cmd: ["pgrep", "-f", marker] });
    expect(probe.exitCode).not.toBe(0);
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
      const r = await runBashCommand("sleep 5", 100, undefined, process.cwd());
      expect(r.timedOut).toBe(true);
      await Bun.sleep(100);
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
    const marker = `/tmp/pim-test-active-${Date.now()}.marker`;
    // Long sleep that would touch a marker file if it ran to completion;
    // a successful sweep kills the bash group before the touch can fire.
    const pending = runBashCommand(
      `sleep 30 && touch ${marker}`,
      30_000,
      undefined,
      process.cwd()
    );
    await Bun.sleep(200);
    killAllActiveBashGroups("SIGTERM");
    const result = await pending;
    expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
    // Wait past the would-be sleep + kill grace; the marker should not exist
    await Bun.sleep(500);
    expect(Bun.file(marker).size).toBe(0);
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

  test("spills full stdout to a temp file when truncated", async () => {
    const totalBytes = STREAM_HEAD_BYTES + STREAM_TAIL_BYTES + 4096;
    const r = await runBashCommand(
      `head -c ${totalBytes} /dev/zero | tr '\\0' 'A'`,
      5000,
      undefined,
      process.cwd()
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.truncated).toBe(true);
    expect(r.stdoutPath).toBeTruthy();
    const spilled = await Bun.file(r.stdoutPath!).text();
    expect(spilled.length).toBe(totalBytes);
    expect(spilled).toBe("A".repeat(totalBytes));
    try {
      Bun.spawnSync({ cmd: ["rm", "-f", r.stdoutPath!] });
    } catch {}
  });

  test("omits spill path when stream is empty", async () => {
    const r = await runBashCommand("true", 5000, undefined, process.cwd());
    expect(r.exitCode).toBe(0);
    expect(r.stdoutPath).toBeNull();
    expect(r.stderrPath).toBeNull();
  });
});
