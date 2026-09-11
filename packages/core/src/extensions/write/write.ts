import { DiffLines, type ToolDiff } from "../../shared/DiffLines";
import { Fs } from "../../shared/Fs";

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

  const oldSide =
    prior === undefined
      ? { lines: [], hasTrailingNewline: false }
      : DiffLines.fromText(prior);
  const newSide = DiffLines.fromText(content);
  const trailingNewlineChange = diffEofChange(oldSide, newSide, created);

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
    oldSide,
    newSide,
    CONTEXT_LINES
  );

  return {
    bytesWritten,
    created,
    ...(diff === undefined ? {} : { diff }),
    ...(trailingNewlineChange === undefined ? {} : { trailingNewlineChange }),
  };
}

function diffEofChange(
  oldSide: { readonly hasTrailingNewline: boolean },
  newSide: { readonly hasTrailingNewline: boolean },
  created: boolean
): "added" | "removed" | undefined {
  if (created || oldSide.hasTrailingNewline === newSide.hasTrailingNewline) {
    return undefined;
  }

  return newSide.hasTrailingNewline ? "added" : "removed";
}

async function readPriorContent(
  absolutePath: string
): Promise<string | undefined> {
  try {
    return await Bun.file(absolutePath).text();
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: unknown }).code === "ENOENT"
    ) {
      return undefined;
    }

    throw error;
  }
}
