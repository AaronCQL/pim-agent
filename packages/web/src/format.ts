const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `25s`, `23m`, `3h`, `2d`. */
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

/** Replaces a `/home/<user>` or `/Users/<user>` prefix with `~`. */
export function abbreviateHome(path: string): string {
  return path.replace(HOME, "~");
}

/** Ignores trailing slashes. */
export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || path;
}

const ELLIPSIS = "…";

/** Truncates to `columns` with an ellipsis in the middle. */
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

/** The first of `texts` (widest first) that fits `columns`, else the last one elided. */
export function fit(texts: readonly string[], columns: number): string {
  return (
    texts.find((text) => text.length <= columns) ??
    elide(texts.at(-1) ?? "", columns)
  );
}

/** `17:24` in local time. */
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
