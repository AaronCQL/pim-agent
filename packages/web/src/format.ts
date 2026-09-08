const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long ago, in the sidebar's one-token form: `25s`, `23m`, `3h`, `2d`. */
export function relativeTime(timestamp: number, now = Date.now()): string {
  if (!Number.isFinite(timestamp)) {
    return "";
  }
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < MINUTE) {
    return `${Math.floor(elapsed / SECOND)}s`;
  }
  if (elapsed < HOUR) {
    return `${Math.floor(elapsed / MINUTE)}m`;
  }
  if (elapsed < DAY) {
    return `${Math.floor(elapsed / HOUR)}h`;
  }
  return `${Math.floor(elapsed / DAY)}d`;
}

const HOME = /^(?:\/home|\/Users)\/[^/]+(?=\/|$)/;

/** `~`-collapses a path from the server's filesystem, matched by shape; anything else is left alone. */
export function abbreviateHome(path: string): string {
  return path.replace(HOME, "~");
}

/** The directory a path ends in; a trailing slash is not a segment of its own. */
export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || path;
}

/** Cuts a path or branch into the part that may be elided and the part that must survive. */
export function splitTail(text: string): readonly [string, string] {
  const slash = text.lastIndexOf("/") + 1;
  const centred = slash * 3 >= text.length && slash * 3 <= text.length * 2;
  const cut = centred ? slash : Math.ceil(text.length / 2);
  return [text.slice(0, cut), text.slice(cut)];
}

/** Wall-clock `17:24` for an epoch stamp, in the reader's own timezone. */
export function clockTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "";
  }
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
