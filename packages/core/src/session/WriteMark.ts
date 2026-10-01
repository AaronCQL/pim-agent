import type { EventLog } from "./EventLog";

/** Lines in a session file (`head`) and entries pi holds in memory (`entries`). */
export type WriteMark = {
  readonly head: number;
  readonly entries: number;
};

type EntrySource = {
  getEntries(): readonly unknown[];
};

const UNREAD: WriteMark = { head: 0, entries: 0 };

/** Reads head first so a concurrent append under-counts the file, never over-counts. */
async function of(log: EventLog, source: EntrySource): Promise<WriteMark> {
  return { head: await log.head(), entries: source.getEntries().length };
}

/**
 * Whether another process appended lines since `mark`. Our own writes move both
 * counts together. A mark taken before pi created the file (`head` 0) counts
 * the header plus every buffered entry as ours.
 */
function foreignSince(mark: WriteMark, next: WriteMark): boolean {
  const base = mark.head === 0 ? { head: 1, entries: 0 } : mark;
  return next.head - base.head - (next.entries - base.entries) > 0;
}

/**
 * Whether every line added since `mark` is a `session_info` (a rename), so no
 * replay is needed. Only meaningful between turns.
 */
async function benignSince(log: EventLog, mark: WriteMark): Promise<boolean> {
  const added = await log.read(mark.head);
  return (
    added.length > 0 &&
    added.every(({ entry }) => entry.type === "session_info")
  );
}

export const WriteMark = { UNREAD, of, foreignSince, benignSince };
