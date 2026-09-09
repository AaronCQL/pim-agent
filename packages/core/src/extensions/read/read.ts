import { Format } from "../../shared/Format";
import { FsErrors } from "../../shared/FsErrors";
import type { VisionModel } from "../../shared/Images";
import { Lines } from "../../shared/Lines";
import { OutputBudget } from "../../shared/OutputBudget";
import {
  assertImageReadable,
  type ImageReadOutcome,
  isImageRead,
  readImage,
  type UnchangedImageReadOutcome,
} from "./image";
import type { ImageMemory } from "./ImageMemory";
import type { ReadRange } from "./schema";

export type TextReadOutcome = {
  readonly kind: "text";
  readonly body: string;
  readonly totalLines: number;
  readonly visibleStart: number;
  readonly visibleEnd: number;
  readonly truncatedByByteCap: boolean;
  readonly truncatedByEnd: boolean;
  readonly hadBom: boolean;
  readonly nextStart?: number;
};

export type ReadOutcome =
  | TextReadOutcome
  | ImageReadOutcome
  | UnchangedImageReadOutcome;

export type ReadOptions = {
  readonly model?: VisionModel;
  /** The pictures this session has already sent; absent when the caller keeps none. */
  readonly memory?: ImageMemory;
};

export function buildReadRange(
  start: number | undefined,
  end: number | undefined
): ReadRange {
  const startLine = start ?? 1;

  if (start !== undefined && (!Number.isInteger(start) || start <= 0)) {
    throw new Error(`Read start ${start} must be a positive integer.`);
  }

  if (end !== undefined && (!Number.isInteger(end) || end <= 0)) {
    throw new Error(`Read end ${end} must be a positive integer.`);
  }

  if (end !== undefined && end < startLine) {
    throw new Error(`Read end line ${end} must be >= start line ${startLine}.`);
  }

  return {
    start: startLine,
    ...(end === undefined ? {} : { end }),
  };
}

export async function readFile(
  path: string,
  range: ReadRange,
  options: ReadOptions = {}
): Promise<ReadOutcome> {
  const metadata = await FsErrors.statOrThrow(path);

  if (metadata.isDirectory()) {
    throw new Error(
      `Path is a directory: ${path}. Use grep or glob to inspect directories.`
    );
  }

  const file = Bun.file(path);

  // One head serves both verdicts: the signature is in its first bytes, a NUL anywhere in it.
  const head = await bytesOf(file.slice(0, Lines.binarySniffBytes), path);

  if (isImageRead(head, path)) {
    assertImageReadable(path, metadata.size, options.model);

    const stamp = { mtimeMs: metadata.mtimeMs, size: metadata.size };
    const remembered = await options.memory?.recall(path, stamp);

    if (remembered !== undefined) {
      return {
        kind: "image-unchanged",
        details: { ...remembered, deduped: true },
      };
    }

    const outcome = await readImage(await bytesOf(file, path), path);
    options.memory?.remember(path, stamp, outcome.details);
    return outcome;
  }

  if (Lines.isBinaryBytes(head)) {
    throw new Error(
      `Read only supports UTF-8 text files but given path is a binary file. Use bash with 'file' or 'xxd' to inspect binary contents.`
    );
  }

  const bytes = await bytesOf(file, path);
  const hadBom = Lines.hasUtf8Bom(bytes);
  const text = new TextDecoder("utf-8").decode(bytes);

  return renderText(Lines.stripUtf8Bom(text), range, path, hadBom);
}

async function bytesOf(file: Bun.BunFile, path: string): Promise<Uint8Array> {
  try {
    return await file.bytes();
  } catch (error) {
    rethrowFsError(error, path, "read");
  }
}

function renderText(
  content: string,
  range: ReadRange,
  path: string,
  hadBom: boolean
): TextReadOutcome {
  const lines = Lines.split(content);
  const totalLines = lines.length;

  if (totalLines === 0) {
    throw new Error("File is empty. Use the write tool to create content.");
  }

  if (range.start > totalLines) {
    throw new Error(
      `Start ${range.start} is beyond end of file (${totalLines} lines total). Use start=1 to read from the beginning, or start=${totalLines} to read the last line.`
    );
  }

  const lastLine = Math.min(range.end ?? totalLines, totalLines);
  const visible: string[] = [];
  let bytes = 0;
  let lastVisibleLine = range.start;

  for (let lineNumber = range.start; lineNumber <= lastLine; lineNumber += 1) {
    const text = `${lineNumber}:${OutputBudget.truncateLine(lines[lineNumber - 1] ?? "")}`;
    const separatorBytes = visible.length === 0 ? 0 : 1;
    const lineBytes = Buffer.byteLength(text, "utf8");

    if (visible.length === 0) {
      if (lineBytes > OutputBudget.maxBytes) {
        throw new Error(
          `Line ${lineNumber} is ${Format.bytes(lineBytes)}, exceeds the ${Format.bytes(OutputBudget.maxBytes)} read cap. Use bash: sed -n '${lineNumber}p' ${path} | head -c ${OutputBudget.maxBytes}${range.start < totalLines ? `, or call read again with start=${range.start + 1} to skip this line.` : "."}`
        );
      }
    } else if (bytes + separatorBytes + lineBytes > OutputBudget.maxBytes) {
      break;
    }

    visible.push(text);
    bytes += separatorBytes + lineBytes;
    lastVisibleLine = lineNumber;
  }

  const body = visible.join("\n");
  const truncatedByByteCap = lastVisibleLine < lastLine;
  const truncatedByEnd = lastVisibleLine < totalLines;

  return {
    kind: "text",
    body,
    totalLines,
    visibleStart: range.start,
    visibleEnd: lastVisibleLine,
    truncatedByByteCap,
    truncatedByEnd,
    hadBom,
    ...(truncatedByEnd ? { nextStart: lastVisibleLine + 1 } : {}),
  };
}

function rethrowFsError(error: unknown, path: string, action: string): never {
  const code = FsErrors.code(error);

  if (code === "EACCES" || code === "EPERM") {
    throw new Error(`Permission denied reading ${path}.`);
  }

  throw new Error(
    `Cannot ${action} ${path}: ${code ?? (error instanceof Error ? error.message : "unknown error")}.`
  );
}
