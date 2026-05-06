import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DiffLines, type ToolDiff } from "../../shared/DiffLines";

const CONTEXT_LINES = 3;

export type WriteOutcome = {
  readonly absolutePath: string;
  readonly bytesWritten: number;
  readonly created: boolean;
  readonly diff?: ToolDiff;
};

export async function writeContent(
  absolutePath: string,
  content: string
): Promise<WriteOutcome> {
  const prior = await readPriorContent(absolutePath);
  const bytesWritten = Buffer.byteLength(content, "utf8");

  if (prior === content) {
    return { absolutePath, bytesWritten, created: false };
  }

  await mkdir(dirname(absolutePath), { recursive: true });
  await Bun.write(absolutePath, content);

  const diff = DiffLines.buildToolDiff(
    absolutePath,
    prior === undefined ? [] : DiffLines.splitLines(prior),
    DiffLines.splitLines(content),
    CONTEXT_LINES
  );

  return {
    absolutePath,
    bytesWritten,
    created: prior === undefined,
    ...(diff === undefined ? {} : { diff }),
  };
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
