const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago, in the sidebar's one-token form: `25s`, `23m`, `3h`, `2d`.
 *
 * Coarser than a date because the list is ordered most-recent-first and the
 * only question a row answers is "how stale is this" — an absolute timestamp
 * would be wider than the cwd beside it and say less.
 */
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

/** `/home/x` and `/Users/x`, the two layouts a POSIX home actually has. */
const HOME = /^(?:\/home|\/Users)\/[^/]+(?=\/|$)/;

/**
 * `~`-collapses a path from the **server's** filesystem, which is the only
 * kind of path this client ever sees. The browser has no home directory to
 * compare against and the wire does not carry the server's, so this matches
 * the shape instead. Anything else — Windows, `/root`, a container path — is
 * left alone rather than guessed at.
 */
export function abbreviateHome(path: string): string {
  return path.replace(HOME, "~");
}
