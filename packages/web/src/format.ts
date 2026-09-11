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

const ELLIPSIS = "…";

/** `text` in `columns` character cells, the middle spent first so both ends survive, the odd cell to the head. */
export function elide(text: string, columns: number): string {
  if (text.length <= columns) {
    return text;
  }
  if (columns < 1) {
    return "";
  }
  const head = Math.ceil((columns - 1) / 2);
  return `${text.slice(0, head)}${ELLIPSIS}${text.slice(text.length - columns + 1 + head)}`;
}

/** The first of `texts` — widest first — that `columns` cells hold whole, elided when none of them do. */
export function fit(texts: readonly string[], columns: number): string {
  return (
    texts.find((text) => text.length <= columns) ??
    elide(texts.at(-1) ?? "", columns)
  );
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
