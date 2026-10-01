import { EventLog } from "#core/session/EventLog";
import type { SessionDigest } from "#core/session/EventLog";
import type { ReadCursors } from "#core/session/ReadCursors";
import { SearchIndex } from "#core/session/SearchIndex";
import type { SearchHit } from "#core/session/SearchIndex";
import type {
  Pinning,
  SessionEntry,
  SessionMeta,
} from "#core/session/SessionMeta";
import type {
  SessionRegistry,
  SessionSummary,
} from "#core/session/SessionRegistry";
import { FileWatch } from "#core/shared/FileWatch";
import { Pool } from "#core/shared/Pool";
import type { Command } from "#protocol/Command";
import type {
  ProjectView,
  SearchHitView,
  ServerEvent,
  SessionListing,
  SessionSearch,
  SessionStatus,
  SessionSummaryView,
} from "#protocol/ServerEvent";

export type SessionCatalogueDeps = {
  readonly registry: SessionRegistry;
  readonly cursors: ReadCursors;
  readonly meta: SessionMeta;
  readonly liveStatus: (sessionId: string) => SessionStatus | undefined;
  readonly liveSessionIds: () => Iterable<string>;
  readonly isBeingRead: (sessionId: string) => boolean;
  readonly announce: (event: ServerEvent) => void;
};

const DEFAULT_SESSION_LIMIT = 50;

/** Concurrent digest reads; each reads a whole file into memory. */
const DIGEST_READS = 16;

/** Debounce for `sessions_changed`. */
const ANNOUNCE_MS = 500;

type CachedDigest = SessionDigest & { readonly modifiedAt: number };

type Overrides = ReadonlyMap<string, SessionEntry>;

type PageScope = {
  readonly overrides: Overrides;
  readonly archived: boolean;
  readonly limit: number;
  readonly perProject: number;
};

export class SessionCatalogue {
  private readonly deps: SessionCatalogueDeps;
  private readonly digests = new Map<string, CachedDigest>();
  private readonly activity = new Map<string, SessionStatus>();
  private readonly settled = new Map<string, number>();
  private readonly watches = new Map<string, () => void>();
  private index: SearchIndex;
  private watching = false;
  private announcing: ReturnType<typeof setTimeout> | undefined;

  public constructor(deps: SessionCatalogueDeps) {
    this.deps = deps;
    this.index = this.newIndex();
  }

  /** Watches the sessions tree, so sessions started by other processes are announced. */
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
  ): Promise<SessionListing> {
    const [summaries, overrides, pinning] = await Promise.all([
      this.deps.registry.list(command.cwd),
      this.deps.meta.sessions(),
      this.deps.meta.pinning(),
    ]);
    // Prune only when unfiltered, or other directories would be forgotten.
    if (command.cwd === undefined) {
      const alive = new Set([
        ...summaries.map((summary) => summary.sessionId),
        ...this.deps.liveSessionIds(),
      ]);
      await Promise.all([
        this.deps.cursors.prune(alive),
        this.deps.meta.prune(alive),
      ]);
      this.forget(alive, new Set(summaries.map((summary) => summary.path)));
    }
    const scope = command.archived === true;
    // Filter before paging so out-of-scope rows don't use the page budget.
    const inScope = summaries.filter(
      (summary) =>
        (overrides.get(summary.sessionId)?.archived === true) === scope
    );
    const limit = command.limit ?? DEFAULT_SESSION_LIMIT;
    return {
      sessions: await this.page(inScope, {
        overrides,
        archived: scope,
        limit,
        perProject: command.perProject ?? limit,
      }),
      // Counted before paging.
      projects: projectsOf(inScope, pinning),
    };
  }

  public async search(
    command: Command & { readonly type: "search_sessions" }
  ): Promise<SessionSearch> {
    const overrides = await this.deps.meta.sessions();
    const archivedOf = (sessionId: string): boolean =>
      overrides.get(sessionId)?.archived === true;
    const { hits, dropped, scanned } = await this.index.search(command.query, {
      ...(command.limit === undefined ? {} : { limit: command.limit }),
      ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
      ...(command.archived === undefined
        ? {}
        : {
            accept: (sessionId: string) =>
              archivedOf(sessionId) === command.archived,
          }),
    });
    return {
      hits: hits.map((hit) => hitOf(hit, archivedOf(hit.sessionId))),
      dropped,
      scanned,
    };
  }

  /** Announces a status change; must precede the read mark. */
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

  /** Marks read now, clears the sticky unread flag, and announces it. */
  public async markRead(sessionId: string): Promise<void> {
    await this.deps.cursors.mark(sessionId);
    // The only place the sticky flag is cleared.
    if ((await this.deps.meta.of(sessionId)).unread === true) {
      await this.deps.meta.setUnread(sessionId, false);
    }
    this.deps.announce({ type: "session_read", sessionId });
  }

  public async flush(): Promise<void> {
    await Promise.all([this.deps.cursors.flush(), this.deps.meta.flush()]);
  }

  public clear(): void {
    this.digests.clear();
    this.activity.clear();
    this.settled.clear();
    this.index = this.newIndex();
  }

  private forget(alive: ReadonlySet<string>, paths: ReadonlySet<string>): void {
    for (const map of [this.activity, this.settled]) {
      for (const sessionId of map.keys()) {
        if (!alive.has(sessionId)) {
          map.delete(sessionId);
        }
      }
    }
    for (const path of this.digests.keys()) {
      if (!paths.has(path)) {
        this.digests.delete(path);
      }
    }
  }

  private newIndex(): SearchIndex {
    return new SearchIndex({ list: () => this.deps.registry.list() });
  }

  /**
   * Selects by mtime under a per-project budget and digests only the selection.
   * A session without a title yields no row and refunds its project's budget.
   */
  private async page(
    candidates: readonly SessionSummary[],
    scope: PageScope
  ): Promise<readonly SessionSummaryView[]> {
    const rows: SessionSummaryView[] = [];
    const taken = new Map<string, number>();
    const consumed = new Set<SessionSummary>();
    for (;;) {
      const batch = choose(candidates, consumed, taken, {
        room: scope.limit - rows.length,
        perProject: scope.perProject,
      });
      if (batch.length === 0) {
        break;
      }
      const built = await Pool.mapPooled(batch, DIGEST_READS, (summary) =>
        this.row(summary, scope)
      );
      for (const [index, row] of built.entries()) {
        if (row === undefined) {
          const { cwd } = batch[index]!;
          taken.set(cwd, (taken.get(cwd) ?? 1) - 1);
          continue;
        }
        rows.push(row);
      }
    }
    return rows.sort((a, b) => b.settledAt - a.settledAt);
  }

  /** Undefined for a session with no title (never prompted or named). */
  private async row(
    { sessionId, cwd, path, createdAt, modifiedAt }: SessionSummary,
    { overrides, archived }: PageScope
  ): Promise<SessionSummaryView | undefined> {
    const status = this.deps.liveStatus(sessionId);
    const { title, named, settledAt } = await this.digestOf(
      sessionId,
      path,
      modifiedAt,
      status
    );
    if (title === undefined) {
      return undefined;
    }
    const answeredAt = this.answerTime(sessionId, status, settledAt);
    const unread =
      overrides.get(sessionId)?.unread === true ||
      (await this.deps.cursors.isUnread(sessionId, answeredAt));
    return {
      sessionId,
      cwd,
      createdAt,
      settledAt: answeredAt ?? settledAt ?? createdAt,
      title,
      ...(named === true ? { named } : {}),
      ...(archived ? { archived: true as const } : {}),
      ...(status === undefined || status === "idle" ? {} : { status }),
      ...(unread ? { unread: true } : {}),
    };
  }

  // One watch per directory: recursive `fs.watch` is unreliable across platforms.
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

  // Mid-turn, use the last idle time: the file's time is just the latest write.
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
    sessionId: string,
    path: string,
    modifiedAt: number,
    status: SessionStatus | undefined
  ): Promise<SessionDigest> {
    const name = this.liveName(sessionId);
    const digest =
      this.reusable(path, modifiedAt, status, name) ??
      (await this.readDigest(path, modifiedAt));
    return renamed(digest, name);
  }

  /** Mid-turn the cached digest is reused despite a changed mtime: nothing it holds can have moved. */
  private reusable(
    path: string,
    modifiedAt: number,
    status: SessionStatus | undefined,
    name: string | null | undefined
  ): CachedDigest | undefined {
    const cached = this.digests.get(path);
    if (cached === undefined) {
      return undefined;
    }
    // A cleared name needs the opening message, which only the file has.
    if (name === null && cached.named === true) {
      return undefined;
    }
    const working = status !== undefined && status !== "idle";
    return cached.modifiedAt === modifiedAt || working ? cached : undefined;
  }

  private async readDigest(
    path: string,
    modifiedAt: number
  ): Promise<SessionDigest> {
    const digest = await new EventLog(path).digest();
    this.digests.set(path, { ...digest, modifiedAt });
    return digest;
  }

  /** `null` is live and unnamed; undefined is not live. */
  private liveName(sessionId: string): string | null | undefined {
    const agent = this.deps.registry.peek(sessionId)?.agentSession;
    return agent === undefined
      ? undefined
      : (agent.sessionManager.getSessionName() ?? null);
  }
}

function hitOf(hit: SearchHit, archived: boolean): SearchHitView {
  return {
    sessionId: hit.sessionId,
    cwd: hit.cwd,
    ...(hit.title === undefined ? {} : { title: hit.title }),
    titleRanges: hit.titleRanges,
    ...(hit.opening === undefined ? {} : { opening: hit.opening }),
    settledAt: hit.settledAt,
    ...(archived ? { archived: true as const } : {}),
    snippets: hit.snippets,
    total: hit.total,
  };
}

/** A live session's name wins over the file's. */
function renamed(
  digest: SessionDigest,
  name: string | null | undefined
): SessionDigest {
  return typeof name === "string"
    ? { ...digest, title: name, named: true }
    : digest;
}

/** The next unconsumed sessions to digest, skipping projects over budget. */
function choose(
  candidates: readonly SessionSummary[],
  consumed: Set<SessionSummary>,
  taken: Map<string, number>,
  budget: { readonly room: number; readonly perProject: number }
): readonly SessionSummary[] {
  const batch: SessionSummary[] = [];
  for (const summary of candidates) {
    if (batch.length >= budget.room) {
      break;
    }
    const used = taken.get(summary.cwd) ?? 0;
    if (consumed.has(summary) || used >= budget.perProject) {
      continue;
    }
    taken.set(summary.cwd, used + 1);
    consumed.add(summary);
    batch.push(summary);
  }
  return batch;
}

function projectsOf(
  summaries: readonly SessionSummary[],
  { projects, order }: Pinning
): readonly ProjectView[] {
  const counts = new Map<string, number>();
  for (const { cwd } of summaries) {
    counts.set(cwd, (counts.get(cwd) ?? 0) + 1);
  }
  const ranks = new Map(order.map((cwd, rank) => [cwd, rank]));
  return [...counts].map(([cwd, count]) => {
    const entry = projects.get(cwd);
    return {
      cwd,
      count,
      ...(entry?.pinned === true
        ? { pinned: true as const, pinRank: ranks.get(cwd) ?? 0 }
        : {}),
      ...(entry?.expanded === true ? { expanded: true as const } : {}),
      ...(entry?.label === undefined ? {} : { label: entry.label }),
    };
  });
}
