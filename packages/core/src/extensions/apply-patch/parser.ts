import {
  ADD_FILE_MARKER,
  cleanPath,
  DELETE_FILE_MARKER,
  MOVE_TO_MARKER,
  UPDATE_FILE_MARKER,
} from "../../shared/PatchSummary";
import type { Hunk, Patch, UpdateChunk } from "./types";

const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const EOF_MARKER = "*** End of File";
const CHANGE_CONTEXT_MARKER = "@@ ";
const EMPTY_CHANGE_CONTEXT_MARKER = "@@";
const EMPTY_CHUNK =
  "Update hunk does not contain any context, added, or removed lines. Include at least one line starting with ' ', '+', or '-'.";
const MOVE_DESTINATION_REQUIRED =
  "Invalid *** Move to directive: destination path is required.";

// Matches Codex's ParseError text byte for byte; GPT models recover from it.
function patchError(message: string): Error {
  return new Error(`invalid patch: ${message}`);
}

function hunkError(lineNumber: number, message: string): Error {
  return new Error(`invalid hunk at line ${lineNumber}, ${message}`);
}

export function parsePatch(text: string): Patch {
  const lines = text.trim().split("\n");
  checkBoundaries(lines);

  const hunkLines = lines.slice(1, lines.length - 1);
  const hunks: Hunk[] = [];
  let remaining = hunkLines;
  let lineNumber = 2;

  while (remaining.length > 0) {
    const { hunk, consumed } = parseOneHunk(remaining, lineNumber);
    hunks.push(hunk);
    lineNumber += consumed;
    remaining = remaining.slice(consumed);
  }

  return { hunks };
}

function checkBoundaries(lines: readonly string[]): void {
  if (!lines[0]!.trim().startsWith(BEGIN_PATCH_MARKER)) {
    throw patchError(
      "The first line of the patch must be '*** Begin Patch'. Do not include Markdown fences, prose, or shell heredoc text before it."
    );
  }

  if (lines.at(-1)!.trim() !== END_PATCH_MARKER) {
    throw patchError(
      "The last line of the patch must be '*** End Patch'. Do not include Markdown fences or trailing prose after it."
    );
  }
}

function parseOneHunk(
  lines: readonly string[],
  lineNumber: number
): { readonly hunk: Hunk; readonly consumed: number } {
  const firstLine = lines[0]!.trim();

  const addPath = stripPrefix(firstLine, ADD_FILE_MARKER);
  if (addPath !== undefined) {
    return parseAddHunk(lines, lineNumber, addPath);
  }

  const deletePath = stripPrefix(firstLine, DELETE_FILE_MARKER);
  if (deletePath !== undefined) {
    return parseDeleteHunk(lines, lineNumber, deletePath);
  }

  const updatePath = stripPrefix(firstLine, UPDATE_FILE_MARKER);
  if (updatePath !== undefined) {
    return parseUpdateHunk(lines, lineNumber, updatePath);
  }

  throw hunkError(
    lineNumber,
    `'${firstLine}' is not a valid hunk header. ` +
      "Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'. " +
      "Do not use unified-diff file headers like '---' or '+++' as hunk headers."
  );
}

function parseAddHunk(
  lines: readonly string[],
  lineNumber: number,
  addPath: string
): { readonly hunk: Hunk; readonly consumed: number } {
  let contents = "";
  let consumed = 1;
  for (const line of lines.slice(1)) {
    if (line.startsWith("+")) {
      contents += `${line.slice(1)}\n`;
      consumed += 1;
    } else {
      break;
    }
  }
  const nextLine = lines[consumed];
  if (nextLine !== undefined && !nextLine.trim().startsWith("*")) {
    throw hunkError(
      lineNumber + consumed,
      `Invalid Add File body: '${nextLine}' must start with '+'. Added file content lines must start with '+'.`
    );
  }
  return {
    hunk: { kind: "add", path: cleanPath(addPath), contents },
    consumed,
  };
}

function parseDeleteHunk(
  lines: readonly string[],
  lineNumber: number,
  deletePath: string
): { readonly hunk: Hunk; readonly consumed: number } {
  const nextLine = lines[1];
  if (nextLine !== undefined && !nextLine.trim().startsWith("*")) {
    throw hunkError(
      lineNumber + 1,
      `Delete File hunks must not contain content lines, got: '${nextLine}'.`
    );
  }
  return {
    hunk: { kind: "delete", path: cleanPath(deletePath) },
    consumed: 1,
  };
}

function parseUpdateHunk(
  lines: readonly string[],
  lineNumber: number,
  updatePath: string
): { readonly hunk: Hunk; readonly consumed: number } {
  let remaining = lines.slice(1);
  let consumed = 1;

  let movePath: string | undefined;
  const moveLine = remaining[0]?.trim();
  if (moveLine?.startsWith(MOVE_TO_MARKER)) {
    const rawMovePath = moveLine.slice(MOVE_TO_MARKER.length);
    if (rawMovePath.length > 0 && !rawMovePath.startsWith(" ")) {
      throw hunkError(
        lineNumber + consumed,
        "Invalid *** Move to directive: use '*** Move to: {path}'."
      );
    }
    if (cleanPath(rawMovePath).length === 0) {
      throw hunkError(lineNumber + consumed, MOVE_DESTINATION_REQUIRED);
    }
    movePath = cleanPath(rawMovePath);
    remaining = remaining.slice(1);
    consumed += 1;
  } else if (moveLine?.startsWith("*** Move")) {
    throw hunkError(
      lineNumber + consumed,
      `Invalid move directive '${moveLine}'. Use '*** Move to: {path}'.`
    );
  }

  const chunks: UpdateChunk[] = [];
  while (remaining.length > 0) {
    if (remaining[0]!.trim() === "") {
      consumed += 1;
      remaining = remaining.slice(1);
      continue;
    }
    if (remaining[0]!.startsWith("*")) {
      break;
    }

    const { chunk, consumed: chunkLines } = parseUpdateChunk(
      remaining,
      lineNumber + consumed,
      chunks.length === 0
    );
    chunks.push(chunk);
    consumed += chunkLines;
    remaining = remaining.slice(chunkLines);
  }

  if (chunks.length === 0 && movePath === undefined) {
    throw hunkError(
      lineNumber,
      `Update file hunk for path '${cleanPath(updatePath)}' is empty. Include @@ plus at least one context, added, or removed line, or add *** Move to for a pure rename.`
    );
  }

  return {
    hunk: {
      kind: "update",
      path: cleanPath(updatePath),
      movePath,
      chunks,
    },
    consumed,
  };
}

function parseUpdateChunk(
  lines: readonly string[],
  lineNumber: number,
  allowMissingContext: boolean
): { readonly chunk: UpdateChunk; readonly consumed: number } {
  const first = lines[0]!;
  const hasMarker =
    first === EMPTY_CHANGE_CONTEXT_MARKER ||
    first.startsWith(CHANGE_CONTEXT_MARKER);
  if (!hasMarker && !allowMissingContext) {
    throw hunkError(
      lineNumber,
      `Expected update hunk to start with a @@ context marker, got: '${first}'. Start each additional edit chunk with @@ or @@ followed by nearby context.`
    );
  }
  const changeContext = stripPrefix(first, CHANGE_CONTEXT_MARKER);
  const startIndex = hasMarker ? 1 : 0;

  if (startIndex >= lines.length) {
    throw hunkError(lineNumber, EMPTY_CHUNK);
  }

  const oldLines: string[] = [];
  const newLines: string[] = [];
  let isEndOfFile = false;
  let parsed = 0;

  for (const line of lines.slice(startIndex)) {
    if (line === EOF_MARKER) {
      if (parsed === 0) {
        throw hunkError(lineNumber, EMPTY_CHUNK);
      }
      isEndOfFile = true;
      parsed += 1;
      break;
    }

    const marker = line[0];
    if (marker === undefined) {
      oldLines.push("");
      newLines.push("");
    } else if (marker === " ") {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
    } else if (marker === "+") {
      newLines.push(line.slice(1));
    } else if (marker === "-") {
      oldLines.push(line.slice(1));
    } else {
      if (parsed === 0) {
        throw hunkError(
          lineNumber,
          `Unexpected line found in update hunk: '${line}'. ` +
            "Every line should start with ' ' (context line), '+' (added line), or '-' (removed line). " +
            "Unchanged context lines must be prefixed with a single space."
        );
      }
      break;
    }
    parsed += 1;
  }

  return {
    chunk: { changeContext, oldLines, newLines, isEndOfFile },
    consumed: parsed + startIndex,
  };
}

function stripPrefix(value: string, prefix: string): string | undefined {
  return value.startsWith(prefix) ? value.slice(prefix.length) : undefined;
}
