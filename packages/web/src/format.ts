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

/**
 * The directory a path ends in, for a viewport with no room for the route to
 * it. Root and a bare `~` are their own last segment, and a trailing slash is
 * not a segment of its own.
 */
export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || path;
}

/**
 * Cuts a path or a branch into the part that may be eaten and the part that
 * must survive: `~/src/pim/` + `packages`, `feat/` + `add-chips`.
 *
 * Middle truncation, done by the layout rather than by counting characters.
 * The head is painted in a shrinking box with `text-overflow: ellipsis` and
 * the tail in a fixed one, so the browser spends every pixel it actually has
 * and elides only what does not fit — where a character budget has to guess
 * the font's width and therefore truncates a wide viewport early and a
 * narrow one late.
 *
 * The last `/` is the natural seam, but only when it lands in the middle
 * third. A head is the half that gets eaten, so a seam near either edge
 * makes one end disposable in full: `feat/` + `add-topbar-chips` loses its
 * prefix on the first pixel of pressure, and silently, since a box shrunk
 * past one character has no room for the ellipsis either. Off-centre names
 * are cut down the middle instead, which keeps both ends whatever the shape.
 */
export function splitTail(text: string): readonly [string, string] {
  const slash = text.lastIndexOf("/") + 1;
  const centred = slash * 3 >= text.length && slash * 3 <= text.length * 2;
  const cut = centred ? slash : Math.ceil(text.length / 2);
  return [text.slice(0, cut), text.slice(cut)];
}

/**
 * Wall-clock `17:24` for the line under a user message, in the *reader's*
 * timezone: the stamp travels as epoch ms precisely so the browser can say
 * when the message happened where the reader is sitting.
 */
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
