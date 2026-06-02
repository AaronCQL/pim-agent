import type { Stats } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { DiffLines, type ToolDiff } from "../../shared/DiffLines";
import { Fs } from "../../shared/Fs";
import { FsErrors } from "../../shared/FsErrors";
import { Lines } from "../../shared/Lines";
import { Paths } from "../../shared/Paths";
import { seekSequenceMatches } from "./matcher";
import type { Hunk, Patch, UpdateChunk } from "./types";

const CONTEXT_LINES = 3;
const MAX_UPDATE_BYTES = 8 * 1024 * 1024;
const EMPTY_PATCH_MESSAGE =
  "No files were modified. Provide at least one *** Add File, *** Delete File, or *** Update File hunk.";
const NOOP_PATCH_MESSAGE =
  "No files were modified. The patch matched the current file contents but did not change them.";

export type ApplyAction = {
  readonly kind: "add" | "update" | "delete" | "move";
  readonly path: string;
  readonly movePath?: string;
};

// One rendered unit per file operation, pairing the action with its content
// diff (undefined for a delete or a pure rename, which render as title only).
export type ApplyEntry = {
  readonly action: ApplyAction;
  readonly diff: ToolDiff | undefined;
};

export type ApplyOutcome = {
  readonly entries: readonly ApplyEntry[];
};

type FileWrite = {
  readonly path: string;
  readonly displayPath: string;
  readonly cwd: string;
  readonly content: string;
  readonly mode?: number;
  readonly nlink: number;
};

type PlannedAction = {
  readonly action: ApplyAction;
  readonly diff: ToolDiff | undefined;
  readonly write?: FileWrite;
  readonly deletePath?: string;
};

// Only a content-less Update is a true no-op. Add/Delete/Move always change the
// filesystem even when their content diff is empty (e.g. creating an empty file
// or a pure rename), so they must not count toward the net-no-op rejection.
function isNoOpUpdate(entry: PlannedAction): boolean {
  return entry.action.kind === "update" && entry.diff === undefined;
}

export async function applyPatch(
  patch: Patch,
  cwd: string
): Promise<ApplyOutcome> {
  if (patch.hunks.length === 0) {
    throw new Error(EMPTY_PATCH_MESSAGE);
  }

  const planned: PlannedAction[] = [];
  for (const hunk of patch.hunks) {
    planned.push(await planHunk(hunk, cwd));
  }

  if (planned.every(isNoOpUpdate)) {
    throw new Error(NOOP_PATCH_MESSAGE);
  }

  const writes = planned.flatMap((entry) =>
    entry.write === undefined ? [] : [entry.write]
  );
  const deletes = planned.flatMap((entry) =>
    entry.deletePath === undefined ? [] : [entry.deletePath]
  );

  for (const write of writes) {
    await writeFile(write);
  }
  for (const path of deletes) {
    await Bun.file(path).delete();
  }

  return {
    entries: planned.map((entry) => ({
      action: entry.action,
      diff: entry.diff,
    })),
  };
}

async function planHunk(hunk: Hunk, cwd: string): Promise<PlannedAction> {
  if (hunk.kind === "add") {
    return planAdd(hunk.path, hunk.contents, cwd);
  }
  if (hunk.kind === "delete") {
    return planDelete(hunk.path, cwd);
  }
  return planUpdate(hunk, cwd);
}

async function planAdd(
  rawPath: string,
  contents: string,
  cwd: string
): Promise<PlannedAction> {
  const absolutePath = Paths.resolve(rawPath, cwd);

  if (await Bun.file(absolutePath).exists()) {
    throw new Error(
      `Cannot add ${rawPath}: file already exists. Use *** Update File to modify an existing file.`
    );
  }

  await ensureWritableParentPath(absolutePath, rawPath, cwd);

  // Each `+` line contributes its content plus a newline, so `contents` already
  // ends with a trailing newline (matching Codex's added-file output). Write it
  // as-is so the file is properly terminated and matches the rendered diff.
  const newSide = DiffLines.fromText(contents);
  const diff = DiffLines.buildToolDiff(
    rawPath,
    { lines: [], hasTrailingNewline: false },
    newSide,
    CONTEXT_LINES
  );

  return {
    action: { kind: "add", path: rawPath },
    diff,
    write: {
      path: absolutePath,
      displayPath: rawPath,
      cwd,
      content: contents,
      nlink: 1,
    },
  };
}

async function planDelete(
  rawPath: string,
  cwd: string
): Promise<PlannedAction> {
  const absolutePath = Paths.resolve(rawPath, cwd);
  await statPatchTarget(absolutePath, rawPath, "delete");

  const original = await readTextFile(absolutePath, rawPath, "delete");
  const diff = DiffLines.buildToolDiff(
    rawPath,
    DiffLines.fromText(original.content),
    { lines: [], hasTrailingNewline: false },
    CONTEXT_LINES
  );

  return {
    action: { kind: "delete", path: rawPath },
    diff,
    deletePath: absolutePath,
  };
}

async function planUpdate(
  hunk: Extract<Hunk, { kind: "update" }>,
  cwd: string
): Promise<PlannedAction> {
  const absoluteSource = Paths.resolve(hunk.path, cwd);
  const metadata = await statPatchTarget(absoluteSource, hunk.path, "update");
  const canonicalSource = await realpathPatchTarget(
    absoluteSource,
    hunk.path,
    "update"
  );
  if (metadata.size > MAX_UPDATE_BYTES) {
    throw new Error(
      `Cannot update ${hunk.path}: file is too large (${metadata.size} bytes, max ${MAX_UPDATE_BYTES}). Use bash or another purpose-built tool for large-file edits.`
    );
  }

  const original = await readTextFile(canonicalSource, hunk.path, "update");
  const split = Lines.splitWithTrailingNewline(original.content);
  const newLines = applyChunks(split.lines, hunk.chunks, hunk.path);

  const destPath = hunk.movePath ?? hunk.path;
  const absoluteDest = Paths.resolve(destPath, cwd);
  const isMove = hunk.movePath !== undefined && absoluteDest !== absoluteSource;

  if (isMove && (await Bun.file(absoluteDest).exists())) {
    throw new Error(
      `Cannot move ${hunk.path} to ${destPath}: destination already exists. Delete or rename the destination first, or choose a different path.`
    );
  }

  const writePath = isMove ? absoluteDest : canonicalSource;

  await ensureWritableParentPath(writePath, destPath, cwd);

  const oldSide = {
    lines: split.lines,
    hasTrailingNewline: split.hasTrailingNewline,
  };
  const newSide = {
    lines: newLines,
    hasTrailingNewline: split.hasTrailingNewline,
  };
  const diff = DiffLines.buildToolDiff(
    destPath,
    oldSide,
    newSide,
    CONTEXT_LINES
  );

  const content = joinLines(
    newLines,
    original.lineEnding,
    split.hasTrailingNewline
  );
  const restored = original.hadBom ? `${Lines.utf8Bom}${content}` : content;

  return {
    action: isMove
      ? { kind: "move", path: hunk.path, movePath: destPath }
      : { kind: "update", path: hunk.path },
    diff,
    write: {
      path: writePath,
      displayPath: destPath,
      cwd,
      content: restored,
      mode: Number(metadata.mode),
      nlink: metadata.nlink,
    },
    ...(isMove ? { deletePath: absoluteSource } : {}),
  };
}

async function statPatchTarget(
  absolutePath: string,
  displayPath: string,
  operation: "delete" | "update"
): Promise<Stats> {
  let metadata: Stats;
  try {
    metadata = await stat(absolutePath);
  } catch (error) {
    throw new Error(formatStatFailure(displayPath, operation, error));
  }

  if (metadata.isDirectory()) {
    const guidance =
      operation === "delete"
        ? "Delete file hunks can only remove files."
        : "Target a UTF-8 text file instead.";
    throw new Error(
      `Cannot ${operation} ${displayPath}: path is a directory. ${guidance}`
    );
  }

  return metadata;
}

async function realpathPatchTarget(
  absolutePath: string,
  displayPath: string,
  operation: "delete" | "update"
): Promise<string> {
  try {
    return await realpath(absolutePath);
  } catch (error) {
    throw new Error(formatStatFailure(displayPath, operation, error));
  }
}

function formatStatFailure(
  displayPath: string,
  operation: "delete" | "update",
  error: unknown
): string {
  const code = FsErrors.code(error);
  if (operation === "delete") {
    if (code === "ENOENT") {
      return `Failed to delete file ${displayPath}: file does not exist. Use glob to locate the file, or omit this delete hunk.`;
    }
    if (code === "EACCES" || code === "EPERM") {
      return `Failed to delete file ${displayPath}: permission denied.`;
    }
    return `Failed to delete file ${displayPath}: ${errorDetail(error)}.`;
  }

  if (code === "ENOENT") {
    return `Failed to read file to update ${displayPath}: file does not exist. Use *** Add File to create a new file, or use glob to locate the existing file.`;
  }
  if (code === "EACCES" || code === "EPERM") {
    return `Failed to read file to update ${displayPath}: permission denied.`;
  }
  return `Failed to read file to update ${displayPath}: ${errorDetail(error)}.`;
}

function errorDetail(error: unknown): string {
  return (
    FsErrors.code(error) ??
    (error instanceof Error ? error.message : "unknown error")
  );
}

async function ensureWritableParentPath(
  absolutePath: string,
  displayPath: string,
  cwd: string
): Promise<void> {
  const nonDirectoryParent = await findNonDirectoryParent(absolutePath);
  if (nonDirectoryParent === undefined) {
    return;
  }

  throw new Error(
    `Cannot create parent directory ${Paths.displayRelative(
      nonDirectoryParent,
      cwd
    )} for ${displayPath}: a file already exists at that path.`
  );
}

async function findNonDirectoryParent(
  absolutePath: string
): Promise<string | undefined> {
  let current = dirname(absolutePath);

  while (true) {
    try {
      const metadata = await stat(current);
      return metadata.isDirectory() ? undefined : current;
    } catch (error) {
      const code = FsErrors.code(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        return undefined;
      }
    }

    const next = dirname(current);
    if (next === current) {
      return undefined;
    }
    current = next;
  }
}

/**
 * Port of Codex `compute_replacements` + `apply_replacements`, operating on
 * logical lines (no trailing-newline sentinel). A sequential cursor advances
 * through the file; multi-chunk hunks are disambiguated by order.
 */
function applyChunks(
  originalLines: readonly string[],
  chunks: readonly UpdateChunk[],
  path: string
): string[] {
  const replacements: Array<{
    readonly start: number;
    readonly oldLen: number;
    readonly newLines: readonly string[];
  }> = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.changeContext !== undefined) {
      const idx = findUniqueSequence(
        originalLines,
        [chunk.changeContext],
        lineIndex,
        false,
        path
      );
      if (idx.length === 0) {
        throw new Error(
          `Failed to find context '${chunk.changeContext}' in ${path}`
        );
      }
      lineIndex = idx[0]! + 1;
    }

    if (chunk.oldLines.length === 0) {
      const insertionIdx = originalLines.length;
      replacements.push({
        start: insertionIdx,
        oldLen: 0,
        newLines: chunk.newLines,
      });
      continue;
    }

    let pattern = chunk.oldLines;
    let newSlice = chunk.newLines;
    let found = findUniqueSequence(
      originalLines,
      pattern,
      lineIndex,
      chunk.isEndOfFile,
      path
    );

    if (found.length === 0 && pattern.at(-1) === "") {
      pattern = pattern.slice(0, -1);
      if (newSlice.at(-1) === "") {
        newSlice = newSlice.slice(0, -1);
      }
      found = findUniqueSequence(
        originalLines,
        pattern,
        lineIndex,
        chunk.isEndOfFile,
        path
      );
    }

    if (found.length === 0) {
      throw new Error(
        `Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`
      );
    }

    replacements.push({
      start: found[0]!,
      oldLen: pattern.length,
      newLines: newSlice,
    });
    lineIndex = found[0]! + pattern.length;
  }

  replacements.sort((a, b) => a.start - b.start);

  const lines = [...originalLines];
  for (const { start, oldLen, newLines } of [...replacements].reverse()) {
    lines.splice(start, oldLen, ...newLines);
  }
  return lines;
}

function findUniqueSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  eof: boolean,
  path: string
): readonly number[] {
  const matches = seekSequenceMatches(lines, pattern, start, eof);
  if (matches.length <= 1) {
    return matches;
  }

  throw new Error(renderAmbiguousMatch(path, matches));
}

function renderAmbiguousMatch(
  path: string,
  matches: readonly number[]
): string {
  const lineStarts = matches.map((match) => match + 1).join(", ");
  return `Patch matched multiple regions in ${path} (lines ${lineStarts}). Use enough context to make it unique.`;
}

function joinLines(
  lines: readonly string[],
  lineEnding: "\n" | "\r\n",
  hasTrailingNewline: boolean
): string {
  if (lines.length === 0) {
    return "";
  }
  const body = lines.join(lineEnding);
  return hasTrailingNewline ? `${body}${lineEnding}` : body;
}

type ReadFile = {
  readonly content: string;
  readonly lines: readonly string[];
  readonly hadBom: boolean;
  readonly lineEnding: "\n" | "\r\n";
};

async function readTextFile(
  absolutePath: string,
  displayPath: string,
  operation: "delete" | "update"
): Promise<ReadFile> {
  const bytes = await Bun.file(absolutePath).bytes();

  if (bytes.subarray(0, 8192).includes(0)) {
    throw new Error(
      `Cannot ${operation} ${displayPath}: binary file. apply_patch only supports UTF-8 text files.`
    );
  }

  const hadBom = Lines.hasUtf8Bom(bytes);
  const decoded = Lines.stripUtf8Bom(new TextDecoder("utf-8").decode(bytes));
  const content = decoded.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lineEnding = decoded.includes("\r\n") ? "\r\n" : "\n";

  return {
    content,
    lines: Lines.splitWithTrailingNewline(content).lines,
    hadBom,
    lineEnding,
  };
}

async function writeFile(write: FileWrite): Promise<void> {
  try {
    if (write.nlink > 1) {
      await Bun.write(write.path, write.content);
      return;
    }
    await Fs.writeAtomic(write.path, write.content, write.mode);
  } catch (error) {
    throw new Error(formatWriteFailure(write, error));
  }
}

function formatWriteFailure(write: FileWrite, error: unknown): string {
  const code = FsErrors.code(error);
  if (code === "EACCES" || code === "EPERM") {
    return `Cannot write ${write.displayPath}: permission denied.`;
  }

  const failedPath = errorPath(error);
  if (code === "EEXIST") {
    const parentPath = failedPath
      ? Paths.displayRelative(failedPath, write.cwd)
      : "the parent directory";
    return `Cannot create parent directory ${parentPath} for ${write.displayPath}: a file already exists at that path.`;
  }
  if (code === "ENOTDIR") {
    return `Cannot write ${write.displayPath}: a parent path is not a directory.`;
  }

  return `Failed to write ${write.displayPath}: ${errorDetail(error)}.`;
}

function errorPath(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "path" in error
    ? String((error as { readonly path: unknown }).path)
    : undefined;
}

export function formatApplySummary(outcome: ApplyOutcome): string {
  const parts = outcome.entries.map(({ action }) => {
    switch (action.kind) {
      case "add":
        return `added ${action.path}`;
      case "delete":
        return `deleted ${action.path}`;
      case "move":
        return `moved ${action.path} to ${action.movePath}`;
      default:
        return `updated ${action.path}`;
    }
  });
  const noun = parts.length === 1 ? "change" : "changes";
  return `Applied ${parts.length} ${noun}: ${parts.join(", ")}.`;
}
