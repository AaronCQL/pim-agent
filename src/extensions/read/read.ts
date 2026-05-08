import { stat } from "node:fs/promises";
import { FsErrors } from "../../shared/FsErrors";
import { Hashline } from "../../shared/Hashline";
import { MAX_READ_BYTES, type ReadFormat, type ReadRange } from "./schema";

type RenderedLine = {
  readonly lineNumber: number;
  readonly text: string;
};

export type ReadOutcome = {
  readonly body: string;
  readonly totalLines: number;
  readonly visibleStart: number;
  readonly visibleEnd: number;
  readonly truncatedByByteCap: boolean;
  readonly nextStart?: number;
};

export function buildReadRange(
  start: number | undefined,
  end: number | undefined,
  format: ReadFormat | undefined
): ReadRange {
  const startLine = start ?? 1;
  const fmt = format ?? "hashline";

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
    format: fmt,
  };
}

export async function readFile(
  path: string,
  range: ReadRange
): Promise<ReadOutcome> {
  const metadata = await metadataOrThrow(path);

  if (metadata.isDirectory()) {
    throw new Error(
      `Path is a directory: ${path}. Use grep or glob to inspect directories.`
    );
  }

  const file = Bun.file(path);

  let head: Uint8Array;
  try {
    head = new Uint8Array(await file.slice(0, 8192).arrayBuffer());
  } catch (error) {
    rethrowFsError(error, path, "read");
  }

  if (head.includes(0)) {
    throw new Error(
      `Read only supports UTF-8 text files but given path is a binary file. Use bash with 'file' or 'xxd' to inspect binary contents.`
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = await file.bytes();
  } catch (error) {
    rethrowFsError(error, path, "read");
  }

  return renderText(new TextDecoder("utf-8").decode(bytes), range, path);
}

function renderText(
  content: string,
  range: ReadRange,
  path: string
): ReadOutcome {
  const lines = Hashline.splitLines(content);
  const totalLines = lines.length;

  if (totalLines === 0) {
    throw new Error(
      "File is empty. Use edit with prepend or append and omit pos to insert content."
    );
  }

  if (range.start > totalLines) {
    throw new Error(
      `Start ${range.start} is beyond end of file (${totalLines} lines total). Use start=1 to read from the beginning, or start=${totalLines} to read the last line.`
    );
  }

  const lastLine = Math.min(range.end ?? totalLines, totalLines);
  const rendered = renderLines(lines, range.start, lastLine, range.format);
  const { visible, firstLineTooBig } = applyByteCap(rendered);

  if (firstLineTooBig !== undefined) {
    throw new Error(
      `Line ${firstLineTooBig.line} is ${formatBytes(firstLineTooBig.bytes)}, exceeds the ${formatBytes(MAX_READ_BYTES)} read cap. Use bash: sed -n '${firstLineTooBig.line}p' ${path} | head -c ${MAX_READ_BYTES}${range.start < totalLines ? `, or call read again with start=${range.start + 1} to skip this line.` : "."}`
    );
  }

  const lastVisibleLine = visible.at(-1)?.lineNumber ?? range.start;
  const body = visible.map((line) => line.text).join("\n");
  const truncatedByByteCap = lastVisibleLine < lastLine;

  return {
    body,
    totalLines,
    visibleStart: range.start,
    visibleEnd: lastVisibleLine,
    truncatedByByteCap,
    ...(truncatedByByteCap ? { nextStart: lastVisibleLine + 1 } : {}),
  };
}

function renderLines(
  lines: readonly string[],
  start: number,
  end: number,
  format: ReadFormat
): readonly RenderedLine[] {
  const rendered: RenderedLine[] = [];

  for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
    const line = lines[lineNumber - 1] ?? "";
    rendered.push({
      lineNumber,
      text:
        format === "hashline" ? Hashline.formatLine(lineNumber, line) : line,
    });
  }

  return rendered;
}

function applyByteCap(lines: readonly RenderedLine[]): {
  readonly visible: readonly RenderedLine[];
  readonly firstLineTooBig:
    | { readonly line: number; readonly bytes: number }
    | undefined;
} {
  const visible: RenderedLine[] = [];
  let bytes = 0;

  for (const line of lines) {
    const separatorBytes = visible.length === 0 ? 0 : 1;
    const lineBytes = Buffer.byteLength(line.text, "utf8");

    if (visible.length === 0 && lineBytes > MAX_READ_BYTES) {
      return {
        visible,
        firstLineTooBig: { line: line.lineNumber, bytes: lineBytes },
      };
    }

    if (
      visible.length > 0 &&
      bytes + separatorBytes + lineBytes > MAX_READ_BYTES
    ) {
      break;
    }

    visible.push(line);
    bytes += separatorBytes + lineBytes;
  }

  return { visible, firstLineTooBig: undefined };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function metadataOrThrow(
  path: string
): Promise<Awaited<ReturnType<typeof stat>>> {
  try {
    return await stat(path);
  } catch (error) {
    if (FsErrors.code(error) === "ENOENT") {
      throw new Error(
        `File not found: ${path}. Use glob to locate the file or verify the path.`
      );
    }

    rethrowFsError(error, path, "stat");
  }
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
