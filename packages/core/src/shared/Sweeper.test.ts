import { describe, expect, test } from "bun:test";

import { Sweeper } from "./Sweeper";

describe("Sweeper.install", () => {
  test("sweeps once on install and ignores repeat installs", () => {
    let calls = 0;
    const cleanup = (): void => {
      calls += 1;
    };

    Sweeper.install({ cleanup, intervalMs: 3_600_000 });
    Sweeper.install({ cleanup, intervalMs: 3_600_000 });

    expect(calls).toBe(1);
  });
});
