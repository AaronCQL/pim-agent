import { StreamCapture } from "./capture";
import { type BashCommandResult, KILL_GRACE_MS } from "./schema";

async function drain(
  stream: ReadableStream<Uint8Array> | undefined,
  cap: StreamCapture
): Promise<void> {
  if (!stream) {
    return;
  }
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        cap.push(value);
      }
    }
  } catch {
    // stream cancelled; drop remaining bytes
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}

function killGroup(pid: number | undefined, sig: NodeJS.Signals): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {}
  }
}

export async function runBashCommand(
  command: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  cwd: string
): Promise<BashCommandResult> {
  const startedAt = Date.now();
  const stdoutCap = new StreamCapture();
  const stderrCap = new StreamCapture();

  // setsid puts bash and all descendants into a fresh process group with
  // pgid == proc.pid, so we can signal the whole tree on timeout/abort
  // instead of leaving backgrounded grandchildren alive holding our pipes.
  const proc = Bun.spawn({
    cmd: ["setsid", "bash", "-lc", command],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  let timedOut = false;
  let aborted = false;

  // Fire-and-forget drains: a backgrounded child can inherit the subshell's
  // fds and keep the pipes open after bash exits, so we must not block on
  // EOF. We race proc.exited against a wall-clock timeout instead, then
  // cancel the streams to release the pipes.
  const stdoutDrain = drain(
    proc.stdout as unknown as ReadableStream<Uint8Array>,
    stdoutCap
  );
  const stderrDrain = drain(
    proc.stderr as unknown as ReadableStream<Uint8Array>,
    stderrCap
  );
  void stdoutDrain;
  void stderrDrain;

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const exitedPromise = proc.exited.then(() => "exited" as const);
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  let abortResolve: ((v: "aborted") => void) | null = null;
  const abortPromise = new Promise<"aborted">((resolve) => {
    abortResolve = resolve;
  });
  const onAbort = () => {
    aborted = true;
    abortResolve?.("aborted");
  };
  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  try {
    const result = await Promise.race([
      exitedPromise,
      timeoutPromise,
      abortPromise,
    ]);

    if (result === "timeout") {
      timedOut = true;
    }

    if (result !== "exited") {
      killGroup(proc.pid, "SIGTERM");
      const sigkillTimer = setTimeout(() => {
        killGroup(proc.pid, "SIGKILL");
      }, KILL_GRACE_MS);
      try {
        await proc.exited;
      } finally {
        clearTimeout(sigkillTimer);
      }
    }

    exitCode = proc.exitCode ?? null;
    signalCode = (proc.signalCode as NodeJS.Signals | null | undefined) ?? null;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (signal) {
      signal.removeEventListener("abort", onAbort);
    }
    try {
      proc.stdout?.cancel();
    } catch {}
    try {
      proc.stderr?.cancel();
    } catch {}
  }

  return {
    exitCode,
    signal: signalCode,
    stdout: stdoutCap.snapshot(),
    stderr: stderrCap.snapshot(),
    timedOut,
    aborted,
    durationMs: Date.now() - startedAt,
  };
}
