import type { EventLog } from "./EventLog";

/** How much of a session file one process can account for: durable lines, and pi's own entries. */
export type WriteMark = {
  readonly head: number;
  readonly entries: number;
};

/** Pi's in-memory entry list: an `AgentSession`'s `sessionManager`, or one held directly. */
type EntrySource = {
  getEntries(): readonly unknown[];
};

/** Nothing accounted for yet, which `foreignSince` reads as "the file is pi's to write". */
const UNREAD: WriteMark = { head: 0, entries: 0 };

/** Head first: an append between the two reads must under-count the file, never over. */
async function of(log: EventLog, source: EntrySource): Promise<WriteMark> {
  return { head: await log.head(), entries: source.getEntries().length };
}

/**
 * Whether the file gained lines beyond the ones pi appended from memory. A turn, a
 * model change, a compaction, a `/name` and an idle `!bash` all move both counts
 * together, so only a writer that is not this process makes the difference positive.
 *
 * pi names a session file before it writes one, buffering entries until the first
 * assistant reply, so a mark taken before the file exists is answered by the whole of
 * it: header plus every entry pi was holding.
 */
function foreignSince(mark: WriteMark, next: WriteMark): boolean {
  const base = mark.head === 0 ? { head: 1, entries: 0 } : mark;
  return next.head - base.head - (next.entries - base.entries) > 0;
}

/**
 * Whether every line the file gained since `mark` is one no reader has to replay.
 * A rename appends `session_info` and moves no history, so a surface that absorbs
 * it stays on the session it is already holding. Only ask between turns: a window
 * that also holds our own appends is not benign, and a running turn's is.
 */
async function benignSince(log: EventLog, mark: WriteMark): Promise<boolean> {
  const added = await log.read(mark.head);
  return (
    added.length > 0 &&
    added.every(({ entry }) => entry.type === "session_info")
  );
}

/** Write accounting over one session file: whose lines are these? */
export const WriteMark = { UNREAD, of, foreignSince, benignSince };
