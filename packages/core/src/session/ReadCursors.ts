import { join } from "node:path";

import { Fs } from "../shared/Fs";
import { Paths } from "../shared/Paths";

type Stored = {
  readonly baseline: number;
  readonly sessions: Record<string, number>;
};

/** When each session was last read, shared by every client of a machine. */
export class ReadCursors {
  private readonly file: string;
  private readonly ready: Promise<void>;
  private readonly cursors = new Map<string, number>();
  private baseline = 0;
  private readonly writes = Fs.serialised();

  /** Defaults to `~/.pim/read.json`. */
  public constructor(path?: string) {
    this.file = path ?? join(Paths.pimHomeDir(), "read.json");
    this.ready = this.load();
  }

  /** Whether a session has been answered since anything last read it. */
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

  /** Moves a session's cursor forward; the write behind it is not waited on. */
  public async mark(sessionId: string, at: number = Date.now()): Promise<void> {
    await this.ready;
    if ((this.cursors.get(sessionId) ?? this.baseline) >= at) {
      return;
    }
    this.cursors.set(sessionId, at);
    this.persist();
  }

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
    const stored = (await Bun.file(this.file)
      .json()
      .catch(() => undefined)) as Partial<Stored> | undefined;
    if (typeof stored?.baseline !== "number") {
      // Persist the baseline now: recomputing it on each start clears every unread session.
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
