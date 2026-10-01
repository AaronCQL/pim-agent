import { type ImageMimeType, Images } from "../../shared/Images";
import { SpillCache } from "../../shared/SpillCache";
import { StreamCapture } from "./capture";
import { isErrorResult } from "./format";
import { normaliseStdoutImage } from "./image";
import { MemoryCap } from "./MemoryCap";
import {
  type BashCommandResult,
  type CapturedStream,
  DRAIN_GRACE_MS,
  KILL_GRACE_MS,
} from "./schema";

type Reader = ReadableStreamDefaultReader<Uint8Array>;

const activePids = new Set<number>();

const COMMAND_VAR = "PIM_BASH_COMMAND";
// The command goes via env, not argv, so `pkill -f <target>` inside it can't match this shell.
// oom_score_adj makes the command the OOM killer's first victim, not pim.
const RUNNER = `{ echo 500 > /proc/self/oom_score_adj; } 2>/dev/null; __pim_command=$${COMMAND_VAR}; unset ${COMMAND_VAR}; eval "$__pim_command"`;

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
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}

async function spillIfTruncated(
  stream: CapturedStream,
  cap: StreamCapture,
  ext: "out" | "err"
): Promise<string | null> {
  return stream.truncated ? SpillCache.write("bash", ext, cap.full()) : null;
}

/** Sniffs the leading bytes only. Over the size cap, stdout is treated as text. */
export function sniffStdoutImage(cap: StreamCapture): ImageMimeType | null {
  if (
    cap.totalBytes < Images.SNIFF_BYTES ||
    cap.totalBytes > Images.MAX_SOURCE_BYTES
  ) {
    return null;
  }
  return Images.sniff(cap.lead(Images.SNIFF_BYTES));
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
  const scope = await MemoryCap.scope();

  // setsid: own process group (pgid == pid), so the whole tree can be signalled.
  const proc = Bun.spawn({
    cmd: [...(scope?.argv ?? []), "setsid", "bash", "-lc", RUNNER],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, [COMMAND_VAR]: command },
  });
  if (proc.pid !== undefined) {
    activePids.add(proc.pid);
  }

  let timedOut = false;
  let aborted = false;

  // Keep the readers: cancelling a locked stream directly throws.
  const stdoutReader = getReader(
    proc.stdout as unknown as ReadableStream<Uint8Array>
  );
  const stderrReader = getReader(
    proc.stderr as unknown as ReadableStream<Uint8Array>
  );

  // Not awaited: a backgrounded child can hold the pipes open after bash exits.
  const stdoutDrain = drain(stdoutReader, stdoutCap);
  const stderrDrain = drain(stderrReader, stderrCap);

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const exitedPromise = proc.exited.then(() => "exited" as const);
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  const abort = Promise.withResolvers<"aborted">();
  const onAbort = () => {
    aborted = true;
    abort.resolve("aborted");
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
      abort.promise,
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
      if (scope) {
        await MemoryCap.stop(scope.unit);
      }
    }

    exitCode = proc.exitCode ?? null;
    signalCode = (proc.signalCode as NodeJS.Signals | null | undefined) ?? null;

    // Bounded: a detached grandchild may hold the pipe open forever.
    await Promise.race([
      Promise.all([stdoutDrain, stderrDrain]),
      Bun.sleep(DRAIN_GRACE_MS),
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

  // A failed command's image is never decoded.
  const sniffed = sniffStdoutImage(stdoutCap);
  const shows =
    sniffed !== null && !isErrorResult({ exitCode, timedOut, aborted });
  const stdout = stdoutCap.snapshot(sniffed !== null);
  const stderr = stderrCap.snapshot();

  // OOMPolicy=kill SIGKILLs the scope; systemd's own Result for it is racy.
  const memoryLimitHit =
    scope !== null && signalCode === "SIGKILL" && !timedOut && !aborted
      ? scope.limitBytes
      : null;

  const [stdoutPath, stderrPath, stdoutImage] = await Promise.all([
    spillIfTruncated(stdout, stdoutCap, "out"),
    spillIfTruncated(stderr, stderrCap, "err"),
    shows ? normaliseStdoutImage(stdoutCap.full()) : null,
  ]);

  return {
    exitCode,
    signal: signalCode,
    stdout: { ...stdout, path: stdoutPath },
    stderr: { ...stderr, path: stderrPath },
    stdoutSniffed: sniffed,
    stdoutImage,
    timedOut,
    aborted,
    memoryLimitHit,
    durationMs: Date.now() - startedAt,
  };
}
