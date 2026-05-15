import type { Stats } from "node:fs";
import { chmod, realpath, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  EditMatcher,
  type EditMatchStrategy,
  type EditRange,
} from "../../shared/EditMatcher";
import { DiffLines, type ToolDiff } from "../../shared/DiffLines";
import { Lines } from "../../shared/Lines";
import type { RawEdit } from "./schema";

export type NoopEdit = {
  readonly index: number;
  readonly range: string;
};

export type ResolvedEditMetadata = {
  readonly index: number;
  readonly ranges: readonly string[];
  readonly strategy: EditMatchStrategy;
  readonly matchCount: number;
  readonly replaceAll: boolean;
};

export type EditOutcome = {
  readonly editCount: number;
  readonly warnings: readonly string[];
  readonly noops: readonly NoopEdit[];
  readonly ranges: readonly string[];
  readonly resolvedEdits: readonly ResolvedEditMetadata[];
  readonly diff?: ToolDiff;
};

type ParsedEdit = {
  readonly index: number;
  readonly oldString: string;
  readonly newString: string;
  readonly replaceAll: boolean;
};

type ResolvedEdit = {
  readonly index: number;
  readonly ranges: readonly EditRange[];
  readonly newString: string;
  readonly strategy: EditMatchStrategy;
  readonly matchCount: number;
  readonly replaceAll: boolean;
};

type Mutation = {
  readonly index: number;
  readonly range: EditRange;
  readonly newString: string;
};

const CONTEXT_LINES = 2;
const MAX_EDIT_BYTES = 8 * 1024 * 1024;

const editQueues = new Map<string, Promise<void>>();

export async function editFile(
  absolutePath: string,
  rawEdits: readonly RawEdit[]
): Promise<EditOutcome> {
  const canonicalPath = await realpath(absolutePath);

  return enqueue(canonicalPath, () =>
    performEdit(absolutePath, canonicalPath, rawEdits)
  );
}

async function performEdit(
  displayPath: string,
  canonicalPath: string,
  rawEdits: readonly RawEdit[]
): Promise<EditOutcome> {
  const edits = parseEdits(rawEdits);
  const metadata = await stat(canonicalPath);

  if (metadata.isDirectory()) {
    throw new Error(`Path is a directory: ${displayPath}.`);
  }

  if (metadata.size > MAX_EDIT_BYTES) {
    throw new Error(
      `Path exceeds the ${MAX_EDIT_BYTES}-byte edit cap (${metadata.size} bytes): ${displayPath}.`
    );
  }

  assertNoDuplicateEdits(edits);

  const file = Bun.file(canonicalPath);
  const bytes = await file.bytes();

  if (bytes.subarray(0, 8192).includes(0)) {
    throw new Error(
      `Path is a binary file: ${displayPath}. Edit only supports UTF-8 text files.`
    );
  }

  const hadBom = Lines.hasUtf8Bom(bytes);
  const originalContent = Lines.stripUtf8Bom(
    new TextDecoder("utf-8").decode(bytes)
  );
  const lineEnding = originalContent.includes("\r\n") ? "\r\n" : "\n";
  const normalizedEdits = edits.map((edit) => ({
    ...edit,
    oldString: normalizeEditString(edit.oldString, lineEnding),
    newString: normalizeEditString(edit.newString, lineEnding),
  }));
  const resolved = normalizedEdits.map((edit) =>
    resolveEdit(originalContent, edit)
  );
  const allMutations = resolved.flatMap((edit) =>
    edit.ranges.map((range) => ({
      index: edit.index,
      range,
      newString: edit.newString,
    }))
  );

  const sortedMutations = sortMutations(allMutations);
  assertNoOverlaps(sortedMutations);

  const isNoop = (mutation: Mutation) =>
    originalContent.slice(mutation.range[0], mutation.range[1]) ===
    mutation.newString;

  const lineRangeCache = new Map<string, string>();
  const lineRange = (range: EditRange): string => {
    const key = `${range[0]}:${range[1]}`;
    let cached = lineRangeCache.get(key);
    if (cached === undefined) {
      cached = EditMatcher.lineRangeFor(originalContent, range);
      lineRangeCache.set(key, cached);
    }
    return cached;
  };

  const noops: NoopEdit[] = [];
  const effectiveMutations: Mutation[] = [];
  for (const mutation of sortedMutations) {
    if (isNoop(mutation)) {
      noops.push({ index: mutation.index, range: lineRange(mutation.range) });
    } else {
      effectiveMutations.push(mutation);
    }
  }

  if (effectiveMutations.length === 0) {
    throw new Error(renderAllNoopError(noops));
  }

  const nextContent = EditMatcher.applyAll(originalContent, effectiveMutations);

  await writeFileAtomic(
    canonicalPath,
    hadBom ? `${Lines.utf8Bom}${nextContent}` : nextContent,
    metadata
  );

  const original = Lines.splitWithTrailingNewline(originalContent);
  const next = Lines.splitWithTrailingNewline(nextContent);
  const diff = DiffLines.buildToolDiff(
    displayPath,
    original,
    next,
    CONTEXT_LINES
  );

  const resolvedEdits = resolved.map((edit) => ({
    index: edit.index,
    ranges: edit.ranges.map((range) => lineRange(range)),
    strategy: edit.strategy,
    matchCount: edit.matchCount,
    replaceAll: edit.replaceAll,
  }));

  return {
    editCount: edits.length,
    warnings: [],
    noops,
    ranges: effectiveMutations.map((mutation) => lineRange(mutation.range)),
    resolvedEdits,
    ...(diff === undefined ? {} : { diff }),
  };
}

function parseEdits(rawEdits: readonly RawEdit[]): readonly ParsedEdit[] {
  if (rawEdits.length === 0) {
    throw new Error("Expected non-empty edits array.");
  }

  return rawEdits.map((raw, index) => {
    if (raw.oldString === raw.newString) {
      throw new Error(
        `[E_NOOP_EDIT] Edit ${index}: oldString and newString are identical.`
      );
    }

    return {
      index,
      oldString: raw.oldString,
      newString: raw.newString,
      replaceAll: raw.replaceAll ?? false,
    };
  });
}

function normalizeEditString(text: string, lineEnding: "\n" | "\r\n"): string {
  const normalized = Lines.normalize(text);
  return lineEnding === "\n" ? normalized : normalized.replaceAll("\n", "\r\n");
}

function resolveEdit(content: string, edit: ParsedEdit): ResolvedEdit {
  try {
    const outcome = EditMatcher.resolve(
      content,
      edit.oldString,
      edit.replaceAll
    );
    const ranges = "ranges" in outcome ? outcome.ranges : [outcome.range];

    for (const range of ranges) {
      EditMatcher.assertNoEscapeDrift(
        outcome.strategy,
        edit.newString,
        content.slice(range[0], range[1])
      );
    }

    return {
      index: edit.index,
      ranges,
      newString: edit.newString,
      strategy: outcome.strategy,
      matchCount: outcome.matchCount,
      replaceAll: edit.replaceAll,
    };
  } catch (error) {
    if (error instanceof EditMatcher.NotFoundError) {
      throw new Error(EditMatcher.renderNotFound(error));
    }

    throw error;
  }
}

function assertNoDuplicateEdits(edits: readonly ParsedEdit[]): void {
  const seen = new Map<string, number>();

  for (const [index, edit] of edits.entries()) {
    const key = duplicateKey(edit);
    const previous = seen.get(key);

    if (previous !== undefined) {
      throw new Error(
        `[E_DUPLICATE_EDIT] Edits ${previous} and ${index} are identical. Remove one.`
      );
    }

    seen.set(key, index);
  }
}

function duplicateKey(edit: ParsedEdit): string {
  return JSON.stringify({
    oldString: edit.oldString,
    newString: edit.newString,
    replaceAll: edit.replaceAll,
  });
}

function sortMutations(mutations: readonly Mutation[]): readonly Mutation[] {
  return [...mutations].sort((left, right) => {
    if (left.range[0] !== right.range[0]) {
      return left.range[0] - right.range[0];
    }

    return left.range[1] - right.range[1];
  });
}

function assertNoOverlaps(sorted: readonly Mutation[]): void {
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;

    if (previous.range[1] > current.range[0]) {
      throw new Error(renderOverlapError(previous, current));
    }
  }
}

function renderOverlapError(left: Mutation, right: Mutation): string {
  return [
    `[E_OVERLAPPING_EDITS] Edits ${left.index} and ${right.index} target overlapping byte ranges.`,
    `- Edit ${left.index}: range ${left.range[0]}-${left.range[1]}`,
    `- Edit ${right.index}: range ${right.range[0]}-${right.range[1]}`,
    "Combine into a single edit, or drop one.",
  ].join("\n");
}

function renderAllNoopError(noops: readonly NoopEdit[]): string {
  return [
    "[E_NOOP_EDIT] All edits were no-ops. The file already contains the requested replacement content.",
    "",
    ...noops.map(
      (noop) =>
        `- Edit ${noop.index}: matched range ${noop.range} already equals newString.`
    ),
    "",
    "Re-read the file and widen oldString if you meant to replace adjacent duplicated content.",
  ].join("\n");
}

async function writeFileAtomic(
  canonicalPath: string,
  content: string,
  metadata: Stats
): Promise<void> {
  if (metadata.nlink > 1) {
    await Bun.write(canonicalPath, content);
    return;
  }

  const tempPath = join(
    dirname(canonicalPath),
    `.pim-edit-${process.pid}-${crypto.randomUUID()}.tmp`
  );

  await Bun.write(tempPath, content);
  await chmod(tempPath, Number(metadata.mode));
  await rename(tempPath, canonicalPath);
}

async function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = editQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });

  const queued = previous.then(
    () => current,
    () => current
  );

  editQueues.set(key, queued);

  await previous.catch(() => undefined);

  try {
    return await task();
  } finally {
    release();

    if (editQueues.get(key) === queued) {
      editQueues.delete(key);
    }
  }
}

export function formatEditSummary(
  displayPath: string,
  outcome: EditOutcome
): string {
  const noun = outcome.editCount === 1 ? "edit" : "edits";
  return `${outcome.editCount} ${noun} made to ${displayPath}: lines ${joinHuman(outcome.ranges)}.`;
}

function joinHuman(items: readonly string[]): string {
  if (items.length === 0) {
    return "unknown";
  }

  if (items.length === 1) {
    return items[0] ?? "unknown";
  }

  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
