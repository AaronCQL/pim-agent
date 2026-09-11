import { EventLog } from "#core/session/EventLog";
import type { SessionDigest } from "#core/session/EventLog";
import type { ReadCursors } from "#core/session/ReadCursors";
import type { SessionRegistry } from "#core/session/SessionRegistry";
import { FileWatch } from "#core/shared/FileWatch";
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

/** Long enough that a turn's entries are one announcement, short enough that a new session appears while the user is still looking. */
const ANNOUNCE_MS = 500;

type CachedDigest = SessionDigest & { readonly modifiedAt: number };

export class SessionCatalogue {
  private readonly deps: SessionCatalogueDeps;
  private readonly digests = new Map<string, CachedDigest>();
  private readonly activity = new Map<string, SessionStatus>();
  private readonly settled = new Map<string, number>();
  private readonly watches = new Map<string, () => void>();
  private watching = false;
  private announcing: ReturnType<typeof setTimeout> | undefined;

  public constructor(deps: SessionCatalogueDeps) {
    this.deps = deps;
  }

  /**
   * Follow the sessions tree while anyone is connected. A session the terminal
   * or a vanilla `pi` starts is a file this process never hears about
   * otherwise, and a list nobody asked to re-fetch is a list that never learns
   * about it.
   */
  public watch(active: boolean): void {
    if (active === this.watching) {
      return;
    }
    this.watching = active;
    if (!active) {
      for (const stop of this.watches.values()) {
        stop();
      }
      this.watches.clear();
      clearTimeout(this.announcing);
      this.announcing = undefined;
      return;
    }
    this.follow();
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

  // One watch per directory, never a recursive one: `fs.watch` recursion is unsupported on some platforms and silent on others.
  private follow(): void {
    const root = this.deps.registry.sessionsRoot;
    const wanted = new Set([root, ...FileWatch.subdirectories(root)]);
    for (const [path, stop] of this.watches) {
      if (!wanted.has(path)) {
        stop();
        this.watches.delete(path);
      }
    }
    for (const path of wanted) {
      if (!this.watches.has(path)) {
        this.watches.set(
          path,
          FileWatch.directory(path, () => {
            this.onTreeChange();
          })
        );
      }
    }
  }

  // Debounced: a turn writes a dozen entries, and re-listing is a read of every session header.
  private onTreeChange(): void {
    if (this.announcing !== undefined || !this.watching) {
      return;
    }
    this.announcing = setTimeout(() => {
      this.announcing = undefined;
      this.follow();
      this.deps.announce({ type: "sessions_changed" });
    }, ANNOUNCE_MS);
    this.announcing.unref?.();
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
