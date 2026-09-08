import { EventLog } from "#core/session/EventLog";
import type { SessionDigest } from "#core/session/EventLog";
import type { ReadCursors } from "#core/session/ReadCursors";
import type { SessionRegistry } from "#core/session/SessionRegistry";
import type { Command } from "#protocol/Command";
import type {
  ServerEvent,
  SessionStatus,
  SessionSummaryView,
} from "#protocol/ServerEvent";

export type SessionCatalogueDeps = {
  readonly registry: SessionRegistry;
  /**
   * Which sessions have been read, shared by every client: the mark is a
   * property of the machine, so it is kept beside the sessions rather than
   * in whichever browser happened to be reading.
   */
  readonly cursors: ReadCursors;
  readonly liveStatus: (sessionId: string) => SessionStatus | undefined;
  readonly liveSessionIds: () => Iterable<string>;
  readonly isBeingRead: (sessionId: string) => boolean;
  readonly announce: (event: ServerEvent) => void;
};

/** Enough rows to fill a switcher; the catalogue is read newest-first. */
const DEFAULT_SESSION_LIMIT = 50;

/** A digest and the file state it was read from; a rewrite moves both. */
type CachedDigest = SessionDigest & { readonly modifiedAt: number };

export class SessionCatalogue {
  private readonly deps: SessionCatalogueDeps;
  /**
   * Naming a session costs a read of its whole file, and the sidebar re-lists
   * after every turn — so a file that has not been appended to since the last
   * listing is not read again.
   */
  private readonly digests = new Map<string, CachedDigest>();
  /**
   * The status each session was last announced as. Kept because a stream
   * emits its state on every tool call and every message, and a client only
   * needs the edges — a row starts spinning once and stops once.
   */
  private readonly activity = new Map<string, SessionStatus>();
  /**
   * When each session this server runs last settled, as its file read at the
   * time. Held because that reading is only true of an idle session: see
   * `answerTime`.
   */
  private readonly settled = new Map<string, number>();

  public constructor(deps: SessionCatalogueDeps) {
    this.deps = deps;
  }

  public async list(
    command: Command & { readonly type: "list_sessions" }
  ): Promise<readonly SessionSummaryView[]> {
    const summaries = await this.deps.registry.list(command.cwd);
    // Only an unfiltered listing knows every session there is; pruning
    // against one cut to a cwd would forget every other directory. The
    // sessions this server holds open are alive too — a new chat has a mark
    // before it has a file.
    if (command.cwd === undefined) {
      await this.deps.cursors.prune(
        new Set([
          ...summaries.map((summary) => summary.sessionId),
          ...this.deps.liveSessionIds(),
        ])
      );
    }
    // Only the page about to be sent is digested, so a thousand-session
    // directory is not read to answer for fifty rows.
    //
    // Which is also why the *cut* is by modified time and the *order* is not:
    // a session's settle time is in its digest, so ranking the whole
    // directory by it would mean reading every session on disk to send fifty.
    // A file is never modified before its agent settles, so the two disagree
    // only inside the page, where the sort below has the real answer.
    const page = await Promise.all(
      summaries
        .slice(0, command.limit ?? DEFAULT_SESSION_LIMIT)
        .map(async ({ sessionId, cwd, path, createdAt, modifiedAt }) => {
          const { title, settledAt } = await this.digestOf(path, modifiedAt);
          // Only a session this server holds open has an agent to answer for
          // it; anything else on disk is a file, and a file is never working.
          const status = this.deps.liveStatus(sessionId);
          const answeredAt = this.answerTime(sessionId, status, settledAt);
          const unread = await this.deps.cursors.isUnread(
            sessionId,
            answeredAt
          );
          return {
            sessionId,
            cwd,
            createdAt,
            // The last turn known to have finished; failing that whatever the
            // file last had, which is all there is to date a session running
            // its first one by; failing that, when it was made.
            settledAt: answeredAt ?? settledAt ?? createdAt,
            ...(title === undefined ? {} : { title }),
            ...(status === undefined || status === "idle" ? {} : { status }),
            // Off the completed turn alone, so intermediate lines raise no
            // mark: a row goes unread when its turn ends, which is also when
            // it climbs to the top of this list.
            ...(unread ? { unread: true } : {}),
          };
        })
    );
    return page.sort((a, b) => b.settledAt - a.settledAt);
  }

  /**
   * Says that a session's agent started or stopped working, to every client
   * on the server, and only on the edges.
   *
   * A turn that ends under a client that is reading it is read, not unread —
   * and the announcement goes first and synchronously, because it is a frame
   * of the session's own stream and every client attached must see it in the
   * same place. The mark trails it by a microtask, which no client can be
   * inside of: the re-list that frame provokes is a whole round trip away.
   */
  public onStatus(sessionId: string, status: SessionStatus): void {
    if (this.activity.get(sessionId) === status) {
      return;
    }
    this.activity.set(sessionId, status);
    this.deps.announce({ type: "session_activity", sessionId, status });
    if (status === "idle" && this.deps.isBeingRead(sessionId)) {
      void this.markRead(sessionId);
    }
  }

  public track(sessionId: string, status: SessionStatus): void {
    this.activity.set(sessionId, status);
  }

  /**
   * Moves a session's read cursor to now and says so to every client. Said
   * unconditionally, including for a session that was already read: the
   * frame is a few bytes, it is idempotent at every receiver, and the price
   * of skipping it is knowing whether some other client had a dot up.
   */
  public async markRead(sessionId: string): Promise<void> {
    await this.deps.cursors.mark(sessionId);
    this.deps.announce({ type: "session_read", sessionId });
  }

  public flush(): Promise<void> {
    return this.deps.cursors.flush();
  }

  public clear(): void {
    this.digests.clear();
    this.activity.clear();
    this.settled.clear();
  }

  /**
   * When this session's last *completed* turn ended, and — for an idle one —
   * where that answer is remembered from. Absent when there is no such turn
   * to point at: an agent that has never answered, or one whose turn began
   * before any listing had seen it idle.
   *
   * The file's answer is the last thing the agent wrote, which is where it
   * stopped only while nothing is running: mid-turn it is the message or
   * tool result that just landed, and a row would climb to the top of the
   * list — and go unread — on every one of them. So a running session is
   * answered for out of what its file said while it was last idle, and the
   * file takes over again the moment the turn ends.
   *
   * Which makes that freeze best-effort, a listing being the only thing that
   * fills it: a session attached and prompted before anyone listed has
   * nothing remembered, and its row falls back to the file for the length of
   * that turn. Harmless where the sidebar stands, and deliberately not
   * bought with a read on every attach — a running row paints a spinner
   * instead of an age, so the drifting number is never shown, and the unread
   * mark reads the `undefined` this returns rather than the caller's
   * fallback, so it stays down. What is left is a running row sorted higher
   * than it has earned, which is where a running row is expected anyway.
   *
   * Seeding the map where the stream opens is what would close it, and what
   * either of those two changes would need: an age beside a spinner, or an
   * unread mark taken from the listed `settledAt` instead of from here.
   *
   * A session another process is driving reports no status and is always
   * answered for by its file, drifting while that process writes and correct
   * again as soon as it stops: there is no liveness on disk to do better
   * with, and nothing is remembered for it to be wrong about later.
   */
  private answerTime(
    sessionId: string,
    status: SessionStatus | undefined,
    fromFile: number | undefined
  ): number | undefined {
    if (status === undefined) {
      return fromFile;
    }
    if (status !== "idle") {
      return this.settled.get(sessionId);
    }
    if (fromFile !== undefined) {
      this.settled.set(sessionId, fromFile);
    }
    return fromFile;
  }

  private async digestOf(
    path: string,
    modifiedAt: number
  ): Promise<SessionDigest> {
    const cached = this.digests.get(path);
    if (cached?.modifiedAt === modifiedAt) {
      return cached;
    }
    const digest = await new EventLog(path).digest();
    this.digests.set(path, { ...digest, modifiedAt });
    return digest;
  }
}
