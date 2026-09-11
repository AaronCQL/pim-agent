import { Format } from "../../shared/Format";
import { type ImageMimeType, Images } from "../../shared/Images";
import {
  type BashCommandResult,
  type BashDetails,
  type CapturedStream,
  STREAM_HEAD_BYTES,
  STREAM_TAIL_BYTES,
} from "./schema";

const STREAMS = ["stdout", "stderr"] as const;

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
  for (const label of STREAMS) {
    const stream = result[label];
    if (stream.totalBytes === 0) {
      continue;
    }
    if (label === "stdout" && result.stdoutSniffed !== null) {
      const line = unshownImageLine(
        result,
        result.stdoutSniffed,
        stream.totalBytes
      );
      if (line !== null) {
        lines.push(line);
      }
      continue;
    }
    lines.push(`${label}:`);
    lines.push(stripTrailingNewline(stream.text));
    if (stream.truncated) {
      lines.push(formatTruncationAffordance(label, stream));
    }
  }
  return lines.join("\n");
}

/** The words for a picture the content array will not carry; null when it will. */
function unshownImageLine(
  result: BashCommandResult,
  sniffed: ImageMimeType,
  totalBytes: number
): string | null {
  const subject = `stdout is ${Format.bytes(totalBytes)} of ${Images.extensionOf(sniffed)} data`;
  if (isErrorResult(result)) {
    return `[bash tool: ${subject}, not shown because the command failed.]`;
  }
  if (result.stdoutImage === null) {
    return `[bash tool: ${subject} that could not be decoded as an image.]`;
  }
  return null;
}

export function isErrorResult(
  result: Pick<BashCommandResult, "exitCode" | "timedOut" | "aborted">
): boolean {
  return result.aborted || result.timedOut || result.exitCode !== 0;
}

export function detailsOf(result: BashCommandResult): BashDetails {
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    aborted: result.aborted,
    stdout: streamDetails(result.stdout),
    stderr: streamDetails(result.stderr),
    image:
      result.stdoutImage === null
        ? undefined
        : Images.detailsOf(result.stdoutImage),
  };
}

function streamDetails(stream: CapturedStream): BashDetails["stdout"] {
  return {
    totalBytes: stream.totalBytes,
    truncated: stream.truncated,
    path: stream.path,
  };
}
