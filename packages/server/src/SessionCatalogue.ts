import { EventLog } from "#core/session/EventLog";
import type { SessionDigest } from "#core/session/EventLog";
import type { ReadCursors } from "#core/session/ReadCursors";
import { SearchIndex } from "#core/session/SearchIndex";
import type { SearchHit } from "#core/session/SearchIndex";
import type {
  ProjectEntry,
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
  SessionStatus,
  SessionSummaryView,
} from "#protocol/ServerEvent";

export type SessionCatalogueDeps = {
  readonly registry: SessionRegistry;
  /** Which sessions have been read, shared by every client. */
  readonly cursors: ReadCursors;
  /** Archived, held-unread and pinned, shared by every client. */
  readonly meta: SessionMeta;
  readonly liveStatus: (sessionId: string) => SessionStatus | undefined;
  readonly liveSessionIds: () => Iterable<string>;
  readonly isBeingRead: (sessionId: string) => boolean;
  readonly announce: (event: ServerEvent) => void;
};

/** The rows the page kept, and every directory the same scope holds sessions in. */
export type SessionListing = {
  readonly sessions: readonly SessionSummaryView[];
  readonly projects: readonly ProjectView[];
};

/** One search's whole answer: the ranked rows, the words nobody said, and the scope it read. */
export type SessionSearch = {
  readonly hits: readonly SearchHitView[];
  readonly dropped: readonly string[];
  readonly scanned: number;
};

const DEFAULT_SESSION_LIMIT = 50;

/** A digest is a whole-file read; a page of them at once is a page of files in memory at once. */
const DIGEST_READS = 16;

/** Long enough that a turn's entries are one announcement, short enough that a new session appears while the user is still looking. */
const ANNOUNCE_MS = 500;

type CachedDigest = SessionDigest & { readonly modifiedAt: number };

type Overrides = ReadonlyMap<string, SessionEntry>;
type Pins = ReadonlyMap<string, ProjectEntry>;

type PageScope = {
  readonly overrides: Overrides;
  readonly pins: Pins;
  /** True while listing the archived sessions rather than the live ones. */
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
  ): Promise<SessionListing> {
    const [summaries, overrides, pins] = await Promise.all([
      this.deps.registry.list(command.cwd),
      this.deps.meta.sessions(),
      this.deps.meta.projects(),
    ]);
    // Prune only on an unfiltered listing: a cwd-filtered one would forget every other directory.
    if (command.cwd === undefined) {
      const alive = new Set([
        ...summaries.map((summary) => summary.sessionId),
        ...this.deps.liveSessionIds(),
      ]);
      await Promise.all([
        this.deps.cursors.prune(alive),
        this.deps.meta.prune(alive),
      ]);
    }
    const scope = command.archived === true;
    // Before the cut: an archived row that ate the page budget would push a live one off the end.
    const inScope = summaries.filter(
      (summary) =>
        (overrides.get(summary.sessionId)?.archived === true) === scope
    );
    const limit = command.limit ?? DEFAULT_SESSION_LIMIT;
    return {
      sessions: await this.page(inScope, {
        overrides,
        pins,
        archived: scope,
        limit,
        // Absent, a project may fill the page; it is the page that bounds it either way.
        perProject: command.perProject ?? limit,
      }),
      // Counted before the cut, and over the whole scope: a collapsed group says how many it holds, and a row the cut dropped is one a client can still ask for.
      projects: projectsOf(inScope, pins),
    };
  }

  /**
   * The index cannot see the sidecar, so the archived scope is a predicate it
   * calls before its own limit, and the badge is a `Map.get` over the one read
   * of `sessions.json` this query makes.
   */
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

  /** Moves a session's read cursor to now, drops the mark a reader left on it by hand, and says so to every client. */
  public async markRead(sessionId: string): Promise<void> {
    await this.deps.cursors.mark(sessionId);
    // The only place the sticky flag is cleared; a listing must never clear it.
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

  /** One index per catalogue, and so one per session root; the registry's listing is the tree it follows. */
  private newIndex(): SearchIndex {
    return new SearchIndex({ list: () => this.deps.registry.list() });
  }

  /**
   * Selects by modified time under a per-project budget and digests only what
   * it selects: ordering by settle time would read every session on disk. A
   * session with nothing to call itself is not a row, and the budget it spent
   * goes back to its project, so a directory of abandoned files still shows
   * the sessions underneath them.
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

  /** Nothing for a session that never asked anything and was never named: the row it would draw is a truncated UUID. */
  private async row(
    { sessionId, cwd, path, createdAt, modifiedAt }: SessionSummary,
    { overrides, pins, archived }: PageScope
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
      ...(pins.get(cwd)?.pinned === true ? { pinned: true as const } : {}),
      ...(status === undefined || status === "idle" ? {} : { status }),
      ...(unread ? { unread: true } : {}),
    };
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

  /**
   * Mid-turn the file is appended to between listings, so its digest never hits
   * the cache and the whole-file read lands on the busiest session there is.
   * Nothing it answers can have moved: the opening message was written long
   * ago, the settle time is deliberately not read from the file while a turn
   * runs, and the name is the live session's own to say.
   */
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
    // Except a name the live session has since cleared: the opening message a
    // nameless row falls back to is in the file and nowhere else.
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

  /** What a live session calls itself, without reading its file; `null` is live and unnamed. */
  private liveName(sessionId: string): string | null | undefined {
    const agent = this.deps.registry.peek(sessionId)?.agentSession;
    return agent === undefined
      ? undefined
      : (agent.sessionManager.getSessionName() ?? null);
  }
}

/** The row the wire carries: the index's hit, plus the one thing about it only the sidecar knows. */
function hitOf(hit: SearchHit, archived: boolean): SearchHitView {
  return {
    sessionId: hit.sessionId,
    cwd: hit.cwd,
    ...(hit.title === undefined ? {} : { title: hit.title }),
    titleRanges: hit.titleRanges,
    ...(hit.settledAt === undefined ? {} : { settledAt: hit.settledAt }),
    ...(archived ? { archived: true as const } : {}),
    snippets: hit.snippets,
    total: hit.total,
  };
}

/** A live session's own name wins over the file's: a rename lands on the row before the digest behind it expires. */
function renamed(
  digest: SessionDigest,
  name: string | null | undefined
): SessionDigest {
  return typeof name === "string"
    ? { ...digest, title: name, named: true }
    : digest;
}

/** The next sessions to digest, newest first, skipping the projects that have spent their budget and the candidates an earlier round already took. */
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

/** Every working directory the scope holds sessions in, newest first; the count is the header scan's, so it owes nothing to the page. */
function projectsOf(
  summaries: readonly SessionSummary[],
  pins: Pins
): readonly ProjectView[] {
  const counts = new Map<string, number>();
  for (const { cwd } of summaries) {
    counts.set(cwd, (counts.get(cwd) ?? 0) + 1);
  }
  return [...counts].map(([cwd, count]) => ({
    cwd,
    count,
    ...(pins.get(cwd)?.pinned === true ? { pinned: true as const } : {}),
  }));
}
