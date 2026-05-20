import { StreamCapture } from "./capture";
import {
  type BashCommandResult,
  DRAIN_GRACE_MS,
  KILL_GRACE_MS,
} from "./schema";

type Reader = ReadableStreamDefaultReader<Uint8Array>;

const activePids = new Set<number>();

// Wired into the extension's signal handlers so a daemon that `setsid`s
// out of our group (or harbor/parent SIGTERM) still tears down its subtree.
export function killAllActiveBashGroups(sig: NodeJS.Signals = "SIGTERM"): void {
  for (const pid of activePids) {
    killGroup(pid, sig);
  }
  activePids.clear();
}

async function drain(reader: Reader | null, cap: StreamCapture): Promise<void> {
  if (!reader) {
    return;
  }
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
    // reader cancelled; drop remaining bytes
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

function getReader(
  stream: ReadableStream<Uint8Array> | undefined
): Reader | null {
  return stream ? stream.getReader() : null;
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

  // setsid puts bash and its descendants into a fresh process group with
  // pgid == proc.pid, so we can signal the whole tree on timeout/abort
  // instead of leaving backgrounded grandchildren alive holding our pipes.
  const proc = Bun.spawn({
    cmd: ["setsid", "bash", "-lc", command],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  if (proc.pid !== undefined) {
    activePids.add(proc.pid);
  }

  let timedOut = false;
  let aborted = false;

  // We own the readers so we can force-cancel them later even while the
  // background drains are still mid-read. Cancelling via the held reader
  // does not throw the way ReadableStream.cancel() on a locked stream does.
  const stdoutReader = getReader(
    proc.stdout as unknown as ReadableStream<Uint8Array>
  );
  const stderrReader = getReader(
    proc.stderr as unknown as ReadableStream<Uint8Array>
  );

  // Fire-and-forget drains. A backgrounded child can inherit the subshell's
  // fds and keep the pipes open after bash exits, so we can't block on EOF;
  // we race proc.exited against a wall-clock timeout instead.
  const stdoutDrain = drain(stdoutReader, stdoutCap);
  const stderrDrain = drain(stderrReader, stderrCap);

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

    // Bound the drain so a detached grandchild holding the pipe can't keep
    // the drain promise + capture buffer alive past this call.
    await Promise.race([
      Promise.all([stdoutDrain, stderrDrain]),
      new Promise<void>((r) => setTimeout(r, DRAIN_GRACE_MS)),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (signal) {
      signal.removeEventListener("abort", onAbort);
    }
    for (const reader of [stdoutReader, stderrReader]) {
      if (!reader) {
        continue;
      }
      try {
        void reader.cancel().catch(() => {});
      } catch {}
    }
    if (proc.pid !== undefined) {
      activePids.delete(proc.pid);
    }
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
