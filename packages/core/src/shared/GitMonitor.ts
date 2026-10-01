import { join } from "node:path";

import { FileWatch } from "./FileWatch";
import { Git, type GitOutcome, type GitState } from "./Git";

export type GitListener = (state: GitState) => void;

/** `value` carries an operation's result, e.g. a commit's sha. */
export type GitRun<T = never> = GitOutcome & { readonly value?: T };

export type GitMonitorDeps = {
  /** Minimum gap between fetches. Defaults to 30s. */
  readonly fetchTtlMs?: number;
  /** Poll for worktree edits, which `.git` never sees. Defaults to 2s. */
  readonly pollMs?: number;
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
  /** Duration and end time of the last read; the poll backs off by these. */
  readMs: number;
  readAt: number;
};

const DEBOUNCE_MS = 200;

const FETCH_TTL_MS = 30_000;

const POLL_MS = 2_000;

/** A slow repository is polled at most once per this many read durations. */
const BACKOFF = 4;

function same(a: GitState, b: GitState): boolean {
  return (
    a.branch === b.branch &&
    a.dirtyCount === b.dirtyCount &&
    a.ahead === b.ahead &&
    a.behind === b.behind &&
    a.revision === b.revision
  );
}

/** One shared reader per repository: watches `.git`, debounces reads, and allows one writing operation at a time. */
export class GitMonitor {
  private readonly entries = new Map<string, Entry>();
  private readonly deps: GitMonitorDeps;

  public constructor(deps: GitMonitorDeps = {}) {
    this.deps = deps;
  }

  /** The listener hears only changes. */
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

  /** The last state read; never waits. */
  public stateOf(cwd: string): GitState {
    return this.entries.get(cwd)?.state ?? Git.EMPTY;
  }

  /** `fetch` also fetches the remote first, at most once per TTL. */
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

  /** Refuses while another operation runs on `cwd`; re-reads after. */
  public async run<T = never>(
    cwd: string,
    operation: () => Promise<GitRun<T>>
  ): Promise<GitRun<T>> {
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
      readMs: 0,
      readAt: 0,
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
    // `false`: a tick must not queue a read behind a slow one.
    const poll = setInterval(() => {
      if (Date.now() - entry.readAt < entry.readMs * BACKOFF) {
        return;
      }
      void this.read(entry, false);
    }, this.deps.pollMs ?? POLL_MS);
    poll.unref?.();
    return () => {
      clearTimeout(timer);
      clearInterval(poll);
      stop();
    };
  }

  /** `restart` re-reads after an in-flight read, which may predate the change. */
  private read(entry: Entry, restart = true): Promise<GitState> {
    if (entry.inFlight) {
      entry.pending ||= restart;
      return entry.inFlight;
    }
    const run = (async (): Promise<GitState> => {
      const started = Date.now();
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
        entry.readAt = Date.now();
        entry.readMs = entry.readAt - started;
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
