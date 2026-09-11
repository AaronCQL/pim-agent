import type { Hunk, Patch, UpdateChunk } from "./types";

const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
export const ADD_FILE_MARKER = "*** Add File: ";
export const DELETE_FILE_MARKER = "*** Delete File: ";
export const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_PREFIX = "*** Move to:";
const EOF_MARKER = "*** End of File";
const CHANGE_CONTEXT_MARKER = "@@ ";
const EMPTY_CHANGE_CONTEXT_MARKER = "@@";

type ParseErrorDetails =
  | { readonly type: "patch"; readonly message: string }
  | {
      readonly type: "hunk";
      readonly message: string;
      readonly lineNumber: number;
    };

/**
 * Match Codex's ParseError Display formats verbatim so GPT models see the exact
 * error strings they were trained to recover from.
 */
function formatParseError(error: ParseErrorDetails): string {
  switch (error.type) {
    case "patch":
      return `invalid patch: ${error.message}`;
    case "hunk":
      return `invalid hunk at line ${error.lineNumber}, ${error.message}`;
  }
}

/**
 * Strict envelope + hunk parser, faithfully ported from Codex's
 * `parse_patch_text` (strict mode). The envelope check trims the whole text,
 * requires the first line to start with `*** Begin Patch` and the last line to
 * trim to exactly `*** End Patch`. Paths have a leading `@` and surrounding
 * quotes stripped.
 */
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
  const first = lines[0]?.trim();
  const last = lines.at(-1)?.trim();

  if (first === undefined || !lines[0]!.trim().startsWith(BEGIN_PATCH_MARKER)) {
    throw new Error(
      formatParseError({
        type: "patch",
        message:
          "The first line of the patch must be '*** Begin Patch'. Do not include Markdown fences, prose, or shell heredoc text before it.",
      })
    );
  }

  if (last !== END_PATCH_MARKER) {
    throw new Error(
      formatParseError({
        type: "patch",
        message:
          "The last line of the patch must be '*** End Patch'. Do not include Markdown fences or trailing prose after it.",
      })
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
    if (
      nextLine !== undefined &&
      !isHunkHeader(nextLine) &&
      !nextLine.trim().startsWith("*")
    ) {
      throw new Error(
        formatParseError({
          type: "hunk",
          lineNumber: lineNumber + consumed,
          message: `Invalid Add File body: '${nextLine}' must start with '+'. Added file content lines must start with '+'.`,
        })
      );
    }
    return {
      hunk: { kind: "add", path: cleanPath(addPath), contents },
      consumed,
    };
  }

  const deletePath = stripPrefix(firstLine, DELETE_FILE_MARKER);
  if (deletePath !== undefined) {
    const nextLine = lines[1];
    if (nextLine !== undefined && !isHunkHeader(nextLine)) {
      if (nextLine.trim().startsWith("*")) {
        return {
          hunk: { kind: "delete", path: cleanPath(deletePath) },
          consumed: 1,
        };
      }
      throw new Error(
        formatParseError({
          type: "hunk",
          lineNumber: lineNumber + 1,
          message: `Delete File hunks must not contain content lines, got: '${nextLine}'.`,
        })
      );
    }
    return {
      hunk: { kind: "delete", path: cleanPath(deletePath) },
      consumed: 1,
    };
  }

  const updatePath = stripPrefix(firstLine, UPDATE_FILE_MARKER);
  if (updatePath !== undefined) {
    let remaining = lines.slice(1);
    let consumed = 1;

    let movePath: string | undefined;
    const moveLine = remaining[0]?.trim();
    if (moveLine?.startsWith(MOVE_TO_PREFIX)) {
      const rawMovePath = moveLine.slice(MOVE_TO_PREFIX.length);
      if (rawMovePath.length === 0) {
        throw new Error(
          formatParseError({
            type: "hunk",
            lineNumber: lineNumber + consumed,
            message:
              "Invalid *** Move to directive: destination path is required.",
          })
        );
      }
      if (!rawMovePath.startsWith(" ")) {
        throw new Error(
          formatParseError({
            type: "hunk",
            lineNumber: lineNumber + consumed,
            message: `Invalid *** Move to directive: use '*** Move to: {path}'.`,
          })
        );
      }
      if (cleanPath(rawMovePath).length === 0) {
        throw new Error(
          formatParseError({
            type: "hunk",
            lineNumber: lineNumber + consumed,
            message:
              "Invalid *** Move to directive: destination path is required.",
          })
        );
      }
      movePath = rawMovePath;
    } else if (moveLine?.startsWith("*** Move")) {
      throw new Error(
        formatParseError({
          type: "hunk",
          lineNumber: lineNumber + consumed,
          message: `Invalid move directive '${moveLine}'. Use '*** Move to: {path}'.`,
        })
      );
    }
    if (movePath !== undefined) {
      remaining = remaining.slice(1);
      consumed += 1;
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

    // An Update with a Move to and no hunks is a valid pure rename; only an
    // Update with neither a move nor any hunks is truly empty.
    if (chunks.length === 0 && movePath === undefined) {
      throw new Error(
        formatParseError({
          type: "hunk",
          lineNumber,
          message: `Update file hunk for path '${cleanPath(updatePath)}' is empty. Include @@ plus at least one context, added, or removed line, or add *** Move to for a pure rename.`,
        })
      );
    }

    return {
      hunk: {
        kind: "update",
        path: cleanPath(updatePath),
        movePath: movePath === undefined ? undefined : cleanPath(movePath),
        chunks,
      },
      consumed,
    };
  }

  throw new Error(
    formatParseError({
      type: "hunk",
      lineNumber,
      message:
        `'${firstLine}' is not a valid hunk header. ` +
        "Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'. " +
        "Do not use unified-diff file headers like '---' or '+++' as hunk headers.",
    })
  );
}

function parseUpdateChunk(
  lines: readonly string[],
  lineNumber: number,
  allowMissingContext: boolean
): { readonly chunk: UpdateChunk; readonly consumed: number } {
  let changeContext: string | undefined;
  let startIndex: number;

  if (lines[0] === EMPTY_CHANGE_CONTEXT_MARKER) {
    changeContext = undefined;
    startIndex = 1;
  } else {
    const ctx = stripPrefix(lines[0]!, CHANGE_CONTEXT_MARKER);
    if (ctx !== undefined) {
      changeContext = ctx;
      startIndex = 1;
    } else {
      if (!allowMissingContext) {
        throw new Error(
          formatParseError({
            type: "hunk",
            lineNumber,
            message: `Expected update hunk to start with a @@ context marker, got: '${lines[0]}'. Start each additional edit chunk with @@ or @@ followed by nearby context.`,
          })
        );
      }
      changeContext = undefined;
      startIndex = 0;
    }
  }

  if (startIndex >= lines.length) {
    throw new Error(
      formatParseError({
        type: "hunk",
        lineNumber,
        message:
          "Update hunk does not contain any context, added, or removed lines. Include at least one line starting with ' ', '+', or '-'.",
      })
    );
  }

  const oldLines: string[] = [];
  const newLines: string[] = [];
  let isEndOfFile = false;
  let parsed = 0;

  for (const line of lines.slice(startIndex)) {
    if (line === EOF_MARKER) {
      if (parsed === 0) {
        throw new Error(
          formatParseError({
            type: "hunk",
            lineNumber,
            message:
              "Update hunk does not contain any context, added, or removed lines. Include at least one line starting with ' ', '+', or '-'.",
          })
        );
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
        throw new Error(
          formatParseError({
            type: "hunk",
            lineNumber,
            message:
              `Unexpected line found in update hunk: '${line}'. ` +
              "Every line should start with ' ' (context line), '+' (added line), or '-' (removed line). " +
              "Unchanged context lines must be prefixed with a single space.",
          })
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

function isHunkHeader(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith(ADD_FILE_MARKER) ||
    trimmed.startsWith(DELETE_FILE_MARKER) ||
    trimmed.startsWith(UPDATE_FILE_MARKER)
  );
}

export function cleanPath(raw: string): string {
  let path = raw.trim();
  if (path.startsWith("@")) {
    path = path.slice(1).trim();
  }
  if (path.length >= 2) {
    const first = path[0]!;
    const last = path.at(-1)!;
    if ((first === '"' || first === "'" || first === "`") && first === last) {
      path = path.slice(1, -1);
    }
  }
  return path;
}
