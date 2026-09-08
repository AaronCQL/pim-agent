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
  /** Which sessions have been read, shared by every client. */
  readonly cursors: ReadCursors;
  readonly liveStatus: (sessionId: string) => SessionStatus | undefined;
  readonly liveSessionIds: () => Iterable<string>;
  readonly isBeingRead: (sessionId: string) => boolean;
  readonly announce: (event: ServerEvent) => void;
};

const DEFAULT_SESSION_LIMIT = 50;

type CachedDigest = SessionDigest & { readonly modifiedAt: number };

export class SessionCatalogue {
  private readonly deps: SessionCatalogueDeps;
  private readonly digests = new Map<string, CachedDigest>();
  private readonly activity = new Map<string, SessionStatus>();
  private readonly settled = new Map<string, number>();

  public constructor(deps: SessionCatalogueDeps) {
    this.deps = deps;
  }

  public async list(
    command: Command & { readonly type: "list_sessions" }
  ): Promise<readonly SessionSummaryView[]> {
    const summaries = await this.deps.registry.list(command.cwd);
    // Prune only on an unfiltered listing: a cwd-filtered one would forget every other directory.
    if (command.cwd === undefined) {
      await this.deps.cursors.prune(
        new Set([
          ...summaries.map((summary) => summary.sessionId),
          ...this.deps.liveSessionIds(),
        ])
      );
    }
    // Cut by modified time and digest only the page: ordering by settle time would read every session on disk.
    const page = await Promise.all(
      summaries
        .slice(0, command.limit ?? DEFAULT_SESSION_LIMIT)
        .map(async ({ sessionId, cwd, path, createdAt, modifiedAt }) => {
          const { title, settledAt } = await this.digestOf(path, modifiedAt);
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
            settledAt: answeredAt ?? settledAt ?? createdAt,
            ...(title === undefined ? {} : { title }),
            ...(status === undefined || status === "idle" ? {} : { status }),
            ...(unread ? { unread: true } : {}),
          };
        })
    );
    return page.sort((a, b) => b.settledAt - a.settledAt);
  }

  /** Announces a status edge to every client; the announcement must precede the read mark. */
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

  /** Moves a session's read cursor to now and says so to every client. */
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

  // A running session must be answered for by its last idle reading: mid-turn the file's time is the line just written.
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
