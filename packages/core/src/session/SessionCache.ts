export type CachedSession = {
  lastUsed: number;
  /** A pinned entry is never evicted, even past capacity. */
  readonly pinned?: boolean;
  dispose(): Promise<void>;
};

export type EvictionHooks = {
  /** Keys in use elsewhere, kept like pinned entries. */
  readonly held?: (key: string) => boolean;
  /** Runs as an entry leaves, before it is disposed. */
  readonly evicted?: (key: string) => void;
};

const CAPACITY = 16;

/** LRU cache of live sessions; evicted entries are disposed. */
export class SessionCache<T extends CachedSession> {
  private readonly capacity: number;
  private readonly hooks: EvictionHooks;
  private readonly entries = new Map<string, T>();

  public constructor(capacity: number = CAPACITY, hooks: EvictionHooks = {}) {
    this.capacity = capacity;
    this.hooks = hooks;
  }

  public get size(): number {
    return this.entries.size;
  }

  /** Does not count as a use. */
  public peek(key: string): T | undefined {
    return this.entries.get(key);
  }

  public touch(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      entry.lastUsed = Date.now();
    }
    return entry;
  }

  public adopt(key: string, value: T): T {
    this.evictIfNeeded();
    this.entries.set(key, value);
    return value;
  }

  public async disposeAll(): Promise<void> {
    const live = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(live.map((entry) => entry.dispose()));
  }

  private evictIfNeeded(): void {
    while (this.entries.size >= this.capacity) {
      const key = this.oldestUnpinned();
      if (key === undefined) {
        return;
      }
      const evicted = this.entries.get(key)!;
      this.entries.delete(key);
      this.hooks.evicted?.(key);
      evicted.dispose().catch((err: unknown) => {
        console.warn(`[pim] failed to dispose evicted session ${key}:`, err);
      });
    }
  }

  private oldestUnpinned(): string | undefined {
    let oldestKey: string | undefined;
    let oldest = Infinity;
    for (const [key, entry] of this.entries) {
      if (
        entry.pinned !== true &&
        this.hooks.held?.(key) !== true &&
        entry.lastUsed < oldest
      ) {
        oldest = entry.lastUsed;
        oldestKey = key;
      }
    }
    return oldestKey;
  }
}
