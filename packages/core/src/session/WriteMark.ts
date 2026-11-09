import type { EventLog } from "./EventLog";

/** The last line of a session file already accounted for. */
export type WriteMark = {
  readonly head: number;
};

export type WriteScan = {
  readonly next: WriteMark;
  /** Another process appended something other than a rename. */
  readonly foreign: boolean;
  /** Another process renamed the session: nothing to replay, but a name read before is stale. */
  readonly renamed: boolean;
};

type EntrySource = {
  getEntry(id: string): unknown;
};

const UNREAD: WriteMark = { head: 0 };

async function at(log: EventLog): Promise<WriteMark> {
  return { head: await log.head() };
}

/**
 * Pi holds an entry in memory before it writes the line, so a line whose id pi
 * does not hold is another process's. Its renames need no replay.
 */
async function scan(
  log: EventLog,
  mark: WriteMark,
  source: EntrySource
): Promise<WriteScan> {
  const added = await log.read(mark.head);
  const theirs = added.filter(
    ({ entry }) =>
      entry.type !== "session" && source.getEntry(entry.id) === undefined
  );
  return {
    next: { head: added.at(-1)?.seq ?? mark.head },
    foreign: theirs.some(({ entry }) => entry.type !== "session_info"),
    renamed: theirs.some(({ entry }) => entry.type === "session_info"),
  };
}

export const WriteMark = { UNREAD, at, scan };
