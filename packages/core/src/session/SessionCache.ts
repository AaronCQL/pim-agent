/** What a cache entry has to offer: a recency stamp and a way to let go. */
export type CachedSession = {
  lastUsed: number;
  dispose(): Promise<void>;
};

const CAPACITY = 16;

/** Live sessions, keyed however the frontend keys them, capped by least-recently-used. */
export class SessionCache<T extends CachedSession> {
  private readonly capacity: number;
  private readonly entries = new Map<string, T>();

  public constructor(capacity: number = CAPACITY) {
    this.capacity = capacity;
  }

  public get size(): number {
    return this.entries.size;
  }

  /** The live entry, if there is one, without counting as a use. */
  public peek(key: string): T | undefined {
    return this.entries.get(key);
  }

  /** The live entry, marked used now so eviction passes over it. */
  public touch(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      entry.lastUsed = Date.now();
    }
    return entry;
  }

  /** Store `value`, disposing the least recently used entry first when full. */
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
    if (this.entries.size < this.capacity) {
      return;
    }
    let oldestKey: string | undefined;
    let oldest = Infinity;
    for (const [key, entry] of this.entries) {
      if (entry.lastUsed < oldest) {
        oldest = entry.lastUsed;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) {
      return;
    }
    const evicted = this.entries.get(oldestKey)!;
    this.entries.delete(oldestKey);
    void evicted.dispose();
  }
}
