import { DiffLines, type ToolDiff } from "../../shared/DiffLines";
import { Fs } from "../../shared/Fs";
import { FsErrors } from "../../shared/FsErrors";

const CONTEXT_LINES = 3;

// Diff.diffLines is O(n*d); skip rendering for multi-MB writes. The write
// itself still happens — only the diff is omitted.
const MAX_DIFF_BYTES = 2 * 1024 * 1024;

export type WriteOutcome = {
  readonly bytesWritten: number;
  readonly created: boolean;
  readonly diff?: ToolDiff;
  readonly diffSkipped?: {
    readonly reason: "size";
    readonly thresholdBytes: number;
    readonly comparedBytes: number;
  };
  // Surfaced in the result text since the renderer doesn't visualize EOF state.
  readonly trailingNewlineChange?: "added" | "removed";
};

export async function writeContent(
  absolutePath: string,
  content: string
): Promise<WriteOutcome> {
  const prior = await readPriorContent(absolutePath);
  const bytesWritten = Buffer.byteLength(content, "utf8");

  if (prior === content) {
    return { bytesWritten, created: false };
  }

  await Fs.writeAtomic(absolutePath, content);

  const created = prior === undefined;
  const priorBytes = prior === undefined ? 0 : Buffer.byteLength(prior, "utf8");
  const comparedBytes = Math.max(priorBytes, bytesWritten);
  const priorNewline = prior?.endsWith("\n") ?? false;
  const contentNewline = content.endsWith("\n");
  const trailingNewlineChange =
    created || priorNewline === contentNewline
      ? undefined
      : contentNewline
        ? "added"
        : "removed";

  if (comparedBytes > MAX_DIFF_BYTES) {
    return {
      bytesWritten,
      created,
      diffSkipped: {
        reason: "size",
        thresholdBytes: MAX_DIFF_BYTES,
        comparedBytes,
      },
      ...(trailingNewlineChange === undefined ? {} : { trailingNewlineChange }),
    };
  }

  const diff = DiffLines.buildToolDiff(
    absolutePath,
    prior === undefined ? DiffLines.emptySide : DiffLines.fromText(prior),
    DiffLines.fromText(content),
    CONTEXT_LINES
  );

  return {
    bytesWritten,
    created,
    ...(diff === undefined ? {} : { diff }),
    ...(trailingNewlineChange === undefined ? {} : { trailingNewlineChange }),
  };
}

async function readPriorContent(
  absolutePath: string
): Promise<string | undefined> {
  try {
    return await Bun.file(absolutePath).text();
  } catch (error) {
    if (FsErrors.code(error) === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}
