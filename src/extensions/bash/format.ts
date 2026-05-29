import {
  type BashCommandResult,
  type BashDetails,
  type CapturedStream,
  STREAM_HEAD_BYTES,
  STREAM_TAIL_BYTES,
} from "./schema";

export function stripTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s.slice(0, -1) : s;
}

export function formatTruncationAffordance(
  label: string,
  s: CapturedStream
): string {
  const base = `[bash tool: ${label} showing first ${STREAM_HEAD_BYTES} bytes + last ${STREAM_TAIL_BYTES} bytes of ${s.totalBytes}`;
  if (s.path) {
    return `${base}; use read with path=${s.path} and start=${s.nextStart} for the rest.]`;
  }
  return `${base}; redirect to a file (e.g. \`cmd > /tmp/out.log\`) and use read for the full output.]`;
}

export function formatResult(
  result: BashCommandResult,
  timeoutMs: number
): string {
  const lines: string[] = [`Exit code: ${result.exitCode ?? "none"}`];
  if (result.signal !== null) {
    lines.push(`Signal: ${result.signal}`);
  }
  if (result.aborted) {
    lines.push("Aborted.");
  } else if (result.timedOut) {
    lines.push(`Timed out after ${timeoutMs} ms.`);
  }
  if (result.stdout.totalBytes > 0) {
    lines.push("stdout:");
    lines.push(stripTrailingNewline(result.stdout.text));
    if (result.stdout.truncated) {
      lines.push(formatTruncationAffordance("stdout", result.stdout));
    }
  }
  if (result.stderr.totalBytes > 0) {
    lines.push("stderr:");
    lines.push(stripTrailingNewline(result.stderr.text));
    if (result.stderr.truncated) {
      lines.push(formatTruncationAffordance("stderr", result.stderr));
    }
  }
  return lines.join("\n");
}

export function isErrorResult(result: BashCommandResult): boolean {
  return result.aborted || result.timedOut || result.exitCode !== 0;
}

export function detailsOf(result: BashCommandResult): BashDetails {
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    aborted: result.aborted,
    stdout: {
      totalBytes: result.stdout.totalBytes,
      truncated: result.stdout.truncated,
      path: result.stdout.path,
    },
    stderr: {
      totalBytes: result.stderr.totalBytes,
      truncated: result.stderr.truncated,
      path: result.stderr.path,
    },
  };
}
