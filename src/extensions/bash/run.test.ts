import { describe, expect, test } from "bun:test";
import { runBashCommand } from "./run";
import { KILL_GRACE_MS, STREAM_HEAD_BYTES, STREAM_TAIL_BYTES } from "./schema";

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
    await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS + 500));
    const probe = Bun.spawnSync({ cmd: ["pgrep", "-f", marker] });
    expect(probe.exitCode).not.toBe(0);
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
});
