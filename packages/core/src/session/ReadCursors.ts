import { join } from "node:path";

import { Fs } from "../shared/Fs";
import { Paths } from "../shared/Paths";

/** The file's shape: when each session was last read, and the default. */
type Stored = {
  readonly baseline: number;
  readonly sessions: Record<string, number>;
};

/**
 * When each session was last read, for every client of a machine at once.
 *
 * Unread is a property of the machine rather than of a browser: one person
 * with a laptop and a phone open on the same server wants the mark to go out
 * in both, and nothing inside either of them can say that.
 *
 * A timestamp per session, compared against the end of that session's last
 * completed turn — not a count of lines. A turn writes many lines and is one
 * thing to be told about, and a message typed into a session is not something
 * its own author needs telling about at all.
 *
 * Nothing here is authoritative. Lose the file and every session reads as
 * read, which is exactly what a first launch does on purpose: a fresh server
 * opens on a quiet list rather than on a wall of dots for conversations its
 * user has already had.
 */
export class ReadCursors {
  private readonly file: string;
  private readonly ready: Promise<void>;
  private readonly cursors = new Map<string, number>();
  /**
   * What a session with no cursor of its own answers with. Set once, when
   * the file is first created, so that everything already on disk is behind
   * it and reads as read.
   */
  private baseline = 0;
  private readonly writes = Fs.serialised();

  /** Defaults to `~/.pim/read.json`. */
  public constructor(path?: string) {
    this.file = path ?? join(Paths.pimHomeDir(), "read.json");
    this.ready = this.load();
  }

  /**
   * Whether a session has been answered since anything last read it.
   *
   * `answeredAt` is the end of the last *completed* turn, so a turn in
   * flight never raises a mark: taking it rather than reading a file is also
   * what keeps this from having an opinion on when a turn is over.
   *
   * A session whose agent has never answered is read: it has nothing to say
   * yet, and the only thing in it is what its own reader typed.
   */
  public async isUnread(
    sessionId: string,
    answeredAt: number | undefined
  ): Promise<boolean> {
    await this.ready;
    return (
      answeredAt !== undefined &&
      answeredAt > (this.cursors.get(sessionId) ?? this.baseline)
    );
  }

  /**
   * Moves a session's cursor forward. The write behind it is not waited on:
   * the answer everything reads is the one in memory, and neither an attach
   * nor an ending turn should hold for a disk that owes them nothing.
   */
  public async mark(sessionId: string, at: number = Date.now()): Promise<void> {
    await this.ready;
    // Never behind the default either: a cursor older than the baseline
    // would make a session more unread than having no cursor at all.
    if ((this.cursors.get(sessionId) ?? this.baseline) >= at) {
      return;
    }
    this.cursors.set(sessionId, at);
    this.persist();
  }

  /**
   * Forgets every session not named, which is how this stays the size of the
   * sessions directory rather than of everything ever read.
   */
  public async prune(alive: ReadonlySet<string>): Promise<void> {
    await this.ready;
    let dropped = false;
    for (const sessionId of this.cursors.keys()) {
      if (!alive.has(sessionId)) {
        this.cursors.delete(sessionId);
        dropped = true;
      }
    }
    if (dropped) {
      this.persist();
    }
  }

  /** Settles the writes behind the marks taken so far, for a clean stop. */
  public async flush(): Promise<void> {
    await this.ready;
    await this.writes.run(async () => undefined);
  }

  private async load(): Promise<void> {
    // A file that will not parse is treated as one that was never there. The
    // most this can be wrong about is a dot, and there is no reading of
    // "corrupt" that is worth failing a session list over.
    const stored = (await Bun.file(this.file)
      .json()
      .catch(() => undefined)) as Partial<Stored> | undefined;
    if (typeof stored?.baseline !== "number") {
      // Written now rather than at the first mark: a baseline recomputed on
      // every start would clear, on every restart, every session that had
      // gone unread since the last one.
      this.baseline = Date.now();
      this.persist();
      return;
    }
    this.baseline = stored.baseline;
    for (const [sessionId, at] of Object.entries(stored.sessions ?? {})) {
      if (typeof at === "number") {
        this.cursors.set(sessionId, at);
      }
    }
  }

  /**
   * One writer at a time, and the whole file each time. Two servers on one
   * machine is the only way to lose a mark to that, which costs a dot that a
   * click puts right.
   *
   * A write that fails is swallowed: the mark holds in memory and dies with
   * the process, which is the same bargain the baseline makes. There is no
   * disk error worth failing a session list — or an ending turn — over.
   */
  private persist(): void {
    void this.writes.run(async () => {
      const stored: Stored = {
        baseline: this.baseline,
        sessions: Object.fromEntries(this.cursors),
      };
      await Fs.writeJson(this.file, stored).catch(() => undefined);
    });
  }
}
