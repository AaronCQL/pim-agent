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
  } finally {
    reader.releaseLock();
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

  const proc = Bun.spawn({
    cmd: ["bash", "-lc", command],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  let timedOut = false;
  let aborted = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGTERM");
    } catch {}
    killTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }, KILL_GRACE_MS);
  }, timeoutMs);

  const onAbort = () => {
    aborted = true;
    try {
      proc.kill("SIGTERM");
    } catch {}
  };
  if (signal) {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  try {
    await Promise.all([
      drain(proc.stdout as unknown as ReadableStream<Uint8Array>, stdoutCap),
      drain(proc.stderr as unknown as ReadableStream<Uint8Array>, stderrCap),
    ]);
    exitCode = await proc.exited;
    signalCode = (proc.signalCode as NodeJS.Signals | null | undefined) ?? null;
  } finally {
    clearTimeout(timeoutHandle);
    if (killTimer) {
      clearTimeout(killTimer);
    }
    if (signal) {
      signal.removeEventListener("abort", onAbort);
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
