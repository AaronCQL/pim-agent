import { expect, test } from "bun:test";

import { SessionCache } from "./SessionCache";

class Entry {
  public lastUsed: number;
  public disposed = false;

  public constructor(lastUsed: number) {
    this.lastUsed = lastUsed;
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
  }
}

test("evicts the least recently used entry to make room", () => {
  const cache = new SessionCache<Entry>(2);
  const oldest = cache.adopt("a", new Entry(1));
  const newer = cache.adopt("b", new Entry(2));

  cache.adopt("c", new Entry(3));

  expect(oldest.disposed).toBe(true);
  expect(newer.disposed).toBe(false);
  expect(cache.peek("a")).toBeUndefined();
  expect(cache.size).toBe(2);
});

test("a touched entry is not the one eviction takes", () => {
  const cache = new SessionCache<Entry>(2);
  const first = cache.adopt("a", new Entry(1));
  const second = cache.adopt("b", new Entry(2));

  cache.touch("a");
  cache.adopt("c", new Entry(3));

  expect(first.disposed).toBe(false);
  expect(second.disposed).toBe(true);
});

test("peeking does not count as a use", () => {
  const cache = new SessionCache<Entry>(2);
  const first = cache.adopt("a", new Entry(1));
  cache.adopt("b", new Entry(2));

  cache.peek("a");
  cache.adopt("c", new Entry(3));

  expect(first.disposed).toBe(true);
});

test("disposing all leaves nothing cached to dispose twice", async () => {
  const cache = new SessionCache<Entry>();
  const entry = cache.adopt("a", new Entry(1));

  await cache.disposeAll();

  expect(entry.disposed).toBe(true);
  expect(cache.size).toBe(0);
  expect(cache.peek("a")).toBeUndefined();
});
