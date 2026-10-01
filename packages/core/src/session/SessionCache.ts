export type CachedSession = {
  lastUsed: number;
  dispose(): Promise<void>;
};

const CAPACITY = 16;

/** LRU cache of live sessions; evicted entries are disposed. */
export class SessionCache<T extends CachedSession> {
  private readonly capacity: number;
  private readonly entries = new Map<string, T>();

  public constructor(capacity: number = CAPACITY) {
    this.capacity = capacity;
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
