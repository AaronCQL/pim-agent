import type { BashCommandResult, BashDetails, CapturedStream } from "./schema";

export function stripTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s.slice(0, -1) : s;
}

export function formatStreamHeader(label: string, s: CapturedStream): string {
  if (!s.truncated) {
    return `${label}:`;
  }
  return `${label} (${s.totalBytes} bytes):`;
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
    lines.push(formatStreamHeader("stdout", result.stdout));
    lines.push(stripTrailingNewline(result.stdout.text));
  }
  if (result.stderr.totalBytes > 0) {
    lines.push(formatStreamHeader("stderr", result.stderr));
    lines.push(stripTrailingNewline(result.stderr.text));
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
  };
}
