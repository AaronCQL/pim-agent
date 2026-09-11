import { expect, test } from "bun:test";
import { RateLimiter } from "./RateLimiter";

type Harness = {
  readonly limiter: RateLimiter;
  readonly sleeps: number[];
  advance: (ms: number) => void;
};

const createHarness = (maxRequests: number, windowMs: number): Harness => {
  let now = 0;
  const sleeps: number[] = [];
  const limiter = new RateLimiter({
    maxRequests,
    windowMs,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });

  return {
    limiter,
    sleeps,
    advance: (ms) => {
      now += ms;
    },
  };
};

test("allows a full burst up to the limit without waiting", async () => {
  const { limiter, sleeps } = createHarness(3, 1000);

  await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);

  expect(sleeps).toEqual([]);
});

test("delays requests beyond the limit until the window slides", async () => {
  const { limiter, sleeps } = createHarness(3, 1000);

  await Promise.all(Array.from({ length: 7 }, () => limiter.acquire()));

  // 3 immediately, the 4th waits one window (freeing all 3), the 7th waits a
  // second window.
  expect(sleeps).toEqual([1000, 1000]);
});

test("does not wait once earlier requests age out of the window", async () => {
  const harness = createHarness(3, 1000);

  await harness.limiter.acquire();
  await harness.limiter.acquire();
  await harness.limiter.acquire();

  harness.advance(1000);

  await harness.limiter.acquire();

  expect(harness.sleeps).toEqual([]);
});

test("serializes concurrent acquisitions in FIFO order", async () => {
  const { limiter } = createHarness(1, 1000);
  const order: number[] = [];

  await Promise.all([
    limiter.acquire().then(() => order.push(1)),
    limiter.acquire().then(() => order.push(2)),
    limiter.acquire().then(() => order.push(3)),
  ]);

  expect(order).toEqual([1, 2, 3]);
});
