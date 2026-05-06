import { chmod, realpath, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DiffLines, type ToolDiff } from "../../shared/DiffLines";
import {
  type Anchor,
  Hashline,
  HashlineMismatchError,
  type HashMismatch,
} from "../../shared/Hashline";
import type { RawEdit } from "./schema";

type ReplaceEdit = {
  readonly op: "replace";
  readonly index: number;
  readonly pos: Anchor;
  readonly end?: Anchor;
  readonly lines: readonly string[];
};

type AppendEdit = {
  readonly op: "append";
  readonly index: number;
  readonly pos?: Anchor;
  readonly lines: readonly string[];
};

type PrependEdit = {
  readonly op: "prepend";
  readonly index: number;
  readonly pos?: Anchor;
  readonly lines: readonly string[];
};

type HashlineEdit = ReplaceEdit | AppendEdit | PrependEdit;

type LineMutation =
  | {
      readonly kind: "replace";
      readonly index: number;
      readonly startLine: number;
      readonly endLine: number;
      readonly lines: readonly string[];
    }
  | {
      readonly kind: "insert";
      readonly index: number;
      readonly boundary: number;
      readonly lines: readonly string[];
    };

export type NoopEdit = {
  readonly index: number;
  readonly range: string;
};

export type EditOutcome = {
  readonly editCount: number;
  readonly warnings: readonly string[];
  readonly noops: readonly NoopEdit[];
  readonly diff?: ToolDiff;
};

const CONTEXT_LINES = 2;
const MAX_EDIT_BYTES = 8 * 1024 * 1024;

const HASHLINE_PREFIX_PATTERN = /^\s*(?:>>>|>>)?\s*(?:[+*]\s*)?\d+[a-z]{2}\|/u;
const HASHLINE_PLUS_PREFIX_PATTERN = /^\s*(?:>>>|>>)?\s*\+\s*\d+[a-z]{2}\|/u;
const TRUNCATION_NOTICE_PATTERN =
  /^\[Showing lines \d+-\d+ of \d+\. Use start=\d+ to continue\.\]$/u;

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
  const { edits, warnings: parseWarnings } = parseEdits(rawEdits);
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
  const [binary, fileText] = await Promise.all([
    Hashline.isBinary(file),
    file.text(),
  ]);

  if (binary) {
    throw new Error(
      `Path is a binary file: ${displayPath}. Edit only supports UTF-8 text files.`
    );
  }

  const lineEnding = fileText.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = Hashline.hasTrailingNewline(fileText);
  const originalLines = Hashline.splitLines(fileText);
  const validation = validateLineEdits(edits, originalLines);
  const outcome = applyLineMutations(originalLines, validation.mutations);
  const body = outcome.lines.join(lineEnding);
  const finalContent =
    hadTrailingNewline && outcome.lines.length > 0
      ? `${body}${lineEnding}`
      : body;

  await writeFileAtomic(canonicalPath, finalContent, metadata);

  const newHasTrailingNewline = hadTrailingNewline && outcome.lines.length > 0;
  const diff = DiffLines.buildToolDiff(
    displayPath,
    { lines: originalLines, hasTrailingNewline: hadTrailingNewline },
    { lines: outcome.lines, hasTrailingNewline: newHasTrailingNewline },
    CONTEXT_LINES
  );

  return {
    editCount: edits.length,
    warnings: [...parseWarnings, ...validation.warnings, ...outcome.warnings],
    noops: outcome.noops,
    ...(diff === undefined ? {} : { diff }),
  };
}

function parseEdits(rawEdits: readonly RawEdit[]): {
  readonly edits: readonly HashlineEdit[];
  readonly warnings: readonly string[];
} {
  if (rawEdits.length === 0) {
    throw new Error("Expected non-empty edits array.");
  }

  const warnings: string[] = [];
  const edits = rawEdits.map((raw, index) => parseEdit(raw, index, warnings));

  return { edits, warnings };
}

function parseEdit(
  raw: RawEdit,
  index: number,
  warnings: string[]
): HashlineEdit {
  if (raw.op === "replace") {
    if (raw.pos === undefined) {
      throw new Error(`Edit ${index}: replace requires "pos".`);
    }

    return {
      op: "replace",
      index,
      pos: Hashline.parseAnchor(raw.pos),
      ...(raw.end === undefined ? {} : { end: Hashline.parseAnchor(raw.end) }),
      lines: readContentLines(raw.content, warnings),
    };
  }

  if (raw.op === "append" || raw.op === "prepend") {
    if (raw.end !== undefined) {
      throw new Error(
        `Edit ${index}: ${capitalize(raw.op)} does not support "end". Use "pos" or omit it.`
      );
    }

    return {
      op: raw.op,
      index,
      ...(raw.pos === undefined ? {} : { pos: Hashline.parseAnchor(raw.pos) }),
      lines: readContentLines(raw.content, warnings),
    };
  }

  throw new Error(
    `Unknown edit op "${String(raw.op)}". Expected "replace", "append", or "prepend".`
  );
}

function validateLineEdits(
  edits: readonly HashlineEdit[],
  fileLines: readonly string[]
): {
  readonly mutations: readonly LineMutation[];
  readonly warnings: readonly string[];
} {
  const mutations: LineMutation[] = [];
  const warnings: string[] = [];
  const mismatches: HashMismatch[] = [];

  for (const edit of edits) {
    if (
      (edit.op === "append" || edit.op === "prepend") &&
      edit.lines.length === 0
    ) {
      throw new Error(
        `${capitalize(edit.op)} with empty content payload. Provide content to insert or remove the edit.`
      );
    }

    if (edit.op === "replace") {
      const pos = resolveAnchor(fileLines, edit.pos, warnings, mismatches);
      const end =
        edit.end === undefined
          ? pos
          : resolveAnchor(fileLines, edit.end, warnings, mismatches);

      if (pos === undefined || end === undefined) {
        continue;
      }

      if (end.line < pos.line) {
        throw new Error(
          `Range start line ${pos.line} must be <= end line ${end.line}.`
        );
      }

      mutations.push({
        kind: "replace",
        index: edit.index,
        startLine: pos.line,
        endLine: end.line,
        lines: edit.lines,
      });
      continue;
    }

    const pos =
      edit.pos === undefined
        ? undefined
        : resolveAnchor(fileLines, edit.pos, warnings, mismatches);

    if (edit.pos !== undefined && pos === undefined) {
      continue;
    }

    mutations.push({
      kind: "insert",
      index: edit.index,
      boundary:
        edit.op === "append"
          ? (pos?.line ?? fileLines.length)
          : (pos?.line ?? 1) - 1,
      lines: edit.lines,
    });
  }

  if (mismatches.length > 0) {
    throw new HashlineMismatchError(mismatches, fileLines);
  }

  assertNoOverlaps(mutations);

  return { mutations, warnings };
}

function resolveAnchor(
  fileLines: readonly string[],
  anchor: Anchor,
  warnings: string[],
  mismatches: HashMismatch[]
): Anchor | undefined {
  const verification = Hashline.verifyAnchor(fileLines, anchor);

  if (verification.ok) {
    return anchor;
  }

  if (anchor.line < 1 || anchor.line > fileLines.length) {
    throw new Error(
      `Line ${anchor.line} does not exist (file has ${fileLines.length} lines).`
    );
  }

  const rebased = Hashline.tryRebaseAnchor(anchor, fileLines, 5);

  if (rebased !== undefined) {
    warnings.push(rebased.warning);
    return { ...anchor, line: rebased.line };
  }

  mismatches.push({
    line: anchor.line,
    expected: anchor.hash,
    actual:
      verification.actual ??
      Hashline.computeLineHash(anchor.line, fileLines[anchor.line - 1] ?? ""),
  });
  return undefined;
}

type ApplyOutcome = {
  readonly lines: readonly string[];
  readonly warnings: readonly string[];
  readonly noops: readonly NoopEdit[];
};

function applyLineMutations(
  originalLines: readonly string[],
  mutations: readonly LineMutation[]
): ApplyOutcome {
  if (mutations.length === 0) {
    return {
      lines: originalLines,
      warnings: [],
      noops: [],
    };
  }

  const lines = [...originalLines];
  const warnings: string[] = [];
  const noops: NoopEdit[] = [];
  const effectiveMutations: LineMutation[] = [];

  for (const mutation of mutations) {
    if (mutation.kind === "replace") {
      const original = originalLines.slice(
        mutation.startLine - 1,
        mutation.endLine
      );

      if (sameLines(original, mutation.lines)) {
        noops.push({
          index: mutation.index,
          range:
            mutation.startLine === mutation.endLine
              ? String(mutation.startLine)
              : `${mutation.startLine}-${mutation.endLine}`,
        });
        continue;
      }
    }

    effectiveMutations.push(mutation);
  }

  if (effectiveMutations.length === 0) {
    throw new Error(renderAllNoopError(noops));
  }

  const sorted = [...effectiveMutations].sort((left, right) => {
    const leftLine = left.kind === "replace" ? left.endLine : left.boundary;
    const rightLine = right.kind === "replace" ? right.endLine : right.boundary;

    if (leftLine !== rightLine) {
      return rightLine - leftLine;
    }

    if (left.kind !== right.kind) {
      return left.kind === "insert" ? -1 : 1;
    }

    return left.index - right.index;
  });

  for (const mutation of sorted) {
    if (mutation.kind === "replace") {
      const startIndex = mutation.startLine - 1;
      const deleteCount = mutation.endLine - mutation.startLine + 1;

      if (
        mutation.lines.length > 0 &&
        mutation.lines.at(-1)?.trim() ===
          (originalLines[mutation.endLine] ?? "").trim()
      ) {
        warnings.push(
          `Edit ${mutation.index} inserted a line that duplicates the next boundary line. If intentional, keep it; otherwise extend end to line ${mutation.endLine + 1}.`
        );
      }

      lines.splice(startIndex, deleteCount, ...mutation.lines);
      continue;
    }

    lines.splice(mutation.boundary, 0, ...mutation.lines);
  }

  return {
    lines,
    warnings,
    noops,
  };
}

function renderAllNoopError(noops: readonly NoopEdit[]): string {
  return [
    "[E_NOOP_EDIT] All edits were no-ops. The file already contains the requested replacement content.",
    "",
    ...noops.map(
      (noop) =>
        `- Edit ${noop.index}: replace range ${noop.range} exactly matches the submitted content.`
    ),
    "",
    "Re-read the file and widen the range if you meant to replace adjacent duplicated content.",
  ].join("\n");
}

function assertNoDuplicateEdits(edits: readonly HashlineEdit[]): void {
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

function duplicateKey(edit: HashlineEdit): string {
  if (edit.op === "replace") {
    return JSON.stringify({
      op: edit.op,
      pos: anchorKey(edit.pos),
      end: anchorKey(edit.end ?? edit.pos),
      lines: edit.lines,
    });
  }

  return JSON.stringify({
    op: edit.op,
    pos: edit.pos === undefined ? undefined : anchorKey(edit.pos),
    lines: edit.lines,
  });
}

function anchorKey(anchor: Anchor): string {
  return `${anchor.line}${anchor.hash}|${anchor.textHint ?? ""}`;
}

function assertNoOverlaps(mutations: readonly LineMutation[]): void {
  for (let index = 0; index < mutations.length; index += 1) {
    const left = mutations[index];

    if (left === undefined) {
      continue;
    }

    for (let inner = index + 1; inner < mutations.length; inner += 1) {
      const right = mutations[inner];

      if (right === undefined) {
        continue;
      }

      if (conflicts(left, right)) {
        throw new Error(renderOverlapError(left, right));
      }
    }
  }
}

function renderOverlapError(left: LineMutation, right: LineMutation): string {
  return [
    `[E_OVERLAPPING_EDITS] Edits ${left.index} and ${right.index} target the same lines.`,
    `- Edit ${left.index}: ${describeMutation(left)}`,
    `- Edit ${right.index}: ${describeMutation(right)}`,
    "Combine into a single replace, or drop one.",
  ].join("\n");
}

function describeMutation(mutation: LineMutation): string {
  if (mutation.kind === "replace") {
    if (mutation.startLine === mutation.endLine) {
      return `replace line ${mutation.startLine}`;
    }

    return `replace lines ${mutation.startLine}-${mutation.endLine}`;
  }

  if (mutation.boundary === 0) {
    return "insert before line 1";
  }

  return `insert after line ${mutation.boundary}`;
}

function conflicts(left: LineMutation, right: LineMutation): boolean {
  if (left.kind === "replace" && right.kind === "replace") {
    return left.startLine <= right.endLine && right.startLine <= left.endLine;
  }

  if (left.kind === "insert" && right.kind === "insert") {
    return left.boundary === right.boundary;
  }

  const replace = left.kind === "replace" ? left : right;
  const insert = left.kind === "insert" ? left : right;

  if (replace.kind !== "replace" || insert.kind !== "insert") {
    return false;
  }

  return (
    insert.boundary >= replace.startLine && insert.boundary < replace.endLine
  );
}

async function writeFileAtomic(
  canonicalPath: string,
  content: string,
  metadata: Awaited<ReturnType<typeof stat>>
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

function readContentLines(
  content: string,
  warnings: string[]
): readonly string[] {
  const lines = Hashline.splitLines(content);
  const stripped = stripNewLinePrefixes(lines);

  if (!sameLines(lines, stripped)) {
    warnings.push(
      "Stripped read/diff prefixes from edit content. Submit literal file content without hashline or diff markers."
    );
  }

  return stripped;
}

function stripNewLinePrefixes(lines: readonly string[]): readonly string[] {
  const stats = collectLinePrefixStats(lines);

  if (stats.nonEmpty === 0) {
    return lines;
  }

  const stripHash =
    stats.hashPrefixCount > 0 && stats.hashPrefixCount === stats.nonEmpty;

  if (!stripHash && stats.diffPlusHashPrefixCount === 0) {
    return lines;
  }

  return lines
    .filter((line) => !TRUNCATION_NOTICE_PATTERN.test(line))
    .map((line) => {
      if (stripHash) {
        return stripLeadingHashlinePrefixes(line);
      }

      if (HASHLINE_PLUS_PREFIX_PATTERN.test(line)) {
        return line.replace(HASHLINE_PREFIX_PATTERN, "");
      }

      return line;
    });
}

function collectLinePrefixStats(lines: readonly string[]): {
  readonly nonEmpty: number;
  readonly hashPrefixCount: number;
  readonly diffPlusHashPrefixCount: number;
} {
  let nonEmpty = 0;
  let hashPrefixCount = 0;
  let diffPlusHashPrefixCount = 0;

  for (const line of lines) {
    if (line.length === 0) {
      continue;
    }

    if (TRUNCATION_NOTICE_PATTERN.test(line)) {
      continue;
    }

    nonEmpty += 1;

    if (HASHLINE_PREFIX_PATTERN.test(line)) {
      hashPrefixCount += 1;
    }

    if (HASHLINE_PLUS_PREFIX_PATTERN.test(line)) {
      diffPlusHashPrefixCount += 1;
    }
  }

  return {
    nonEmpty,
    hashPrefixCount,
    diffPlusHashPrefixCount,
  };
}

function stripLeadingHashlinePrefixes(line: string): string {
  let result = line;
  let previous: string;

  do {
    previous = result;
    result = result.replace(HASHLINE_PREFIX_PATTERN, "");
  } while (result !== previous);

  return result;
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((line, index) => line === right[index])
  );
}

function capitalize(text: string): string {
  return `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`;
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
  const head = `Edited ${displayPath} (${outcome.editCount} ${outcome.editCount === 1 ? "edit" : "edits"}).`;
  const sections: string[] = [head];

  if (outcome.diff !== undefined) {
    sections.push("", "Diff:", ...buildCompactDiffPreview(outcome.diff));
  }

  if (outcome.warnings.length > 0) {
    sections.push(
      "",
      "Warnings:",
      ...outcome.warnings.map((warning) => `- ${warning}`)
    );
  }

  if (outcome.noops.length > 0) {
    sections.push(
      "",
      "No-op:",
      ...outcome.noops.map(
        (noop) => `- Edit ${noop.index}: range ${noop.range}`
      )
    );
  }

  return sections.join("\n");
}

function buildCompactDiffPreview(diff: ToolDiff): readonly string[] {
  return diff.hunks.flatMap((hunk, index) => [
    ...(index === 0 ? [] : ["..."]),
    ...buildCompactHashlineDiffPreview(hunk.lines),
  ]);
}

type DiffLine = ToolDiff["hunks"][number]["lines"][number];

function buildCompactHashlineDiffPreview(
  lines: ToolDiff["hunks"][number]["lines"]
): readonly string[] {
  const rows: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line === undefined) {
      index += 1;
      continue;
    }

    if (line.kind === "context") {
      const run: DiffLine[] = [];

      while (lines[index]?.kind === "context") {
        const next = lines[index];
        if (next !== undefined) {
          run.push(next);
        }
        index += 1;
      }

      if (run.length > 4) {
        rows.push(formatDiffLine(run[0]!));
        rows.push(formatDiffLine(run[1]!));
        rows.push(`... ${run.length - 4} unchanged lines ...`);
        rows.push(formatDiffLine(run[run.length - 2]!));
        rows.push(formatDiffLine(run[run.length - 1]!));
      } else {
        rows.push(...run.map((entry) => formatDiffLine(entry)));
      }

      continue;
    }

    if (line.kind === "removed" && lines[index + 1]?.kind === "added") {
      const removed: DiffLine[] = [];
      const added: DiffLine[] = [];

      while (lines[index]?.kind === "removed") {
        const next = lines[index];
        if (next !== undefined) {
          removed.push(next);
        }
        index += 1;
      }

      while (lines[index]?.kind === "added") {
        const next = lines[index];
        if (next !== undefined) {
          added.push(next);
        }
        index += 1;
      }

      const pairCount = Math.min(removed.length, added.length);

      for (let offset = 0; offset < pairCount; offset += 1) {
        rows.push(
          `${formatDiffLine(removed[offset]!, "*")} -> ${formatDiffLine(
            added[offset]!,
            "*"
          )}`
        );
      }

      rows.push(
        ...removed.slice(pairCount).map((entry) => formatDiffLine(entry))
      );
      rows.push(
        ...added.slice(pairCount).map((entry) => formatDiffLine(entry))
      );
      continue;
    }

    rows.push(formatDiffLine(line));
    index += 1;
  }

  return rows;
}

function formatDiffLine(line: DiffLine, override?: string): string {
  const marker =
    override ??
    (line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " ");

  if (line.kind === "removed") {
    return `${marker}${line.oldLine ?? 0}--|${line.text}`;
  }

  const lineNumber = line.newLine ?? line.oldLine ?? 1;
  return `${marker}${Hashline.formatLine(lineNumber, line.text)}`;
}
