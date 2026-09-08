export const ADD_FILE_MARKER = "*** Add File: ";
export const DELETE_FILE_MARKER = "*** Delete File: ";
export const UPDATE_FILE_MARKER = "*** Update File: ";
export const MOVE_TO_MARKER = "*** Move to:";

const FILE_MARKERS = [
  ADD_FILE_MARKER,
  DELETE_FILE_MARKER,
  UPDATE_FILE_MARKER,
] as const;

// The first affected path, without building the full per-file summary — for
// callers that only need a title (e.g. a tool-call header on the render path).
function firstPath(input: string): string | undefined {
  for (const raw of input.split("\n")) {
    const line = raw.trim();
    for (const marker of FILE_MARKERS) {
      if (line.startsWith(marker)) {
        return cleanPath(line.slice(marker.length));
      }
    }
  }
  return undefined;
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

/**
 * Lightweight, fault-tolerant scan of V4A patch text into a per-file summary.
 * For renderers that need to label a patch without depending on the apply-patch
 * grammar parser; unrecognized lines are ignored rather than throwing.
 */
export const PatchSummary = { firstPath };
