import { join } from "node:path";

import { FileWatch } from "./FileWatch";
import { Git, type GitOutcome, type GitState } from "./Git";

export type GitListener = (state: GitState) => void;

export type GitMonitorDeps = {
  /** How long a fetch stands before another is worth its round trip. */
  readonly fetchTtlMs?: number;
  readonly status?: (cwd: string) => Promise<GitState>;
  readonly fetch?: (cwd: string) => Promise<GitOutcome>;
};

type Entry = {
  readonly cwd: string;
  readonly listeners: Set<GitListener>;
  state: GitState;
  stop: (() => void) | undefined;
  inFlight: Promise<GitState> | undefined;
  pending: boolean;
  fetchedAt: number;
  locked: boolean;
};

/** A checkout writes half the repository; one read has to stand for the burst. */
const DEBOUNCE_MS = 200;

const FETCH_TTL_MS = 30_000;

function same(a: GitState, b: GitState): boolean {
  return (
    a.branch === b.branch &&
    a.dirtyCount === b.dirtyCount &&
    a.ahead === b.ahead &&
    a.behind === b.behind
  );
}

/**
 * One reader of one repository, however many sessions share it: it watches
 * `.git` so a commit anywhere reaches every surface, coalesces the burst a
 * checkout makes into a single read, and serialises the operations that write,
 * which cannot run two at a time over one index.
 */
export class GitMonitor {
  private readonly entries = new Map<string, Entry>();
  private readonly deps: GitMonitorDeps;

  public constructor(deps: GitMonitorDeps = {}) {
    this.deps = deps;
  }

  /** Follows `cwd` until the returned stop is called; the listener hears only changes, after a read of its own. */
  public watch(cwd: string, listener: GitListener): () => void {
    const entry = this.entryOf(cwd);
    entry.listeners.add(listener);
    entry.stop ??= this.follow(entry);
    void this.read(entry, false);
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0) {
        entry.stop?.();
        entry.stop = undefined;
      }
    };
  }

  /** The last state read, without waiting: a caller painting a frame takes what is known now. */
  public stateOf(cwd: string): GitState {
    return this.entries.get(cwd)?.state ?? Git.EMPTY;
  }

  /** Re-reads now; `fetch` also asks the remote, which is what ahead and behind are counted against. */
  public async refresh(
    cwd: string,
    options: { readonly fetch?: boolean } = {}
  ): Promise<GitState> {
    const entry = this.entryOf(cwd);
    const ttl = this.deps.fetchTtlMs ?? FETCH_TTL_MS;
    if (
      options.fetch === true &&
      !entry.locked &&
      Date.now() - entry.fetchedAt > ttl
    ) {
      entry.fetchedAt = Date.now();
      await (this.deps.fetch ?? Git.fetch)(cwd).catch(() => undefined);
    }
    return await this.read(entry);
  }

  /** Runs one writing operation over `cwd`, refusing a second while it lasts and re-reading once it ends. */
  public async run(
    cwd: string,
    operation: () => Promise<GitOutcome>
  ): Promise<GitOutcome> {
    const entry = this.entryOf(cwd);
    if (entry.locked) {
      return {
        ok: false,
        error: "another git operation is already running in this directory",
      };
    }
    entry.locked = true;
    try {
      return await operation();
    } finally {
      entry.locked = false;
      await this.read(entry);
    }
  }

  public dispose(): void {
    for (const entry of this.entries.values()) {
      entry.stop?.();
    }
    this.entries.clear();
  }

  private entryOf(cwd: string): Entry {
    const found = this.entries.get(cwd);
    if (found) {
      return found;
    }
    const entry: Entry = {
      cwd,
      listeners: new Set(),
      state: Git.EMPTY,
      stop: undefined,
      inFlight: undefined,
      pending: false,
      fetchedAt: 0,
      locked: false,
    };
    this.entries.set(cwd, entry);
    return entry;
  }

  private follow(entry: Entry): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = FileWatch.directory(join(entry.cwd, ".git"), () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void this.read(entry);
      }, DEBOUNCE_MS);
      timer.unref?.();
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  }

  /** `restart` re-reads behind a read already running: a change cannot be answered by a read that predates it, a new subscriber can. */
  private read(entry: Entry, restart = true): Promise<GitState> {
    if (entry.inFlight) {
      entry.pending ||= restart;
      return entry.inFlight;
    }
    const run = (async (): Promise<GitState> => {
      try {
        let next = entry.state;
        do {
          entry.pending = false;
          next = await (this.deps.status ?? Git.fetchStatus)(entry.cwd);
        } while (entry.pending);
        this.settle(entry, next);
        return next;
      } catch {
        return entry.state;
      } finally {
        entry.inFlight = undefined;
      }
    })();
    entry.inFlight = run;
    return run;
  }

  private settle(entry: Entry, next: GitState): void {
    if (same(entry.state, next)) {
      return;
    }
    entry.state = next;
    for (const listener of entry.listeners) {
      listener(next);
    }
  }
}
