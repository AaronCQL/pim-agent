import { describe, expect, test } from "bun:test";

import { Git, type GitState } from "./Git";
import { GitMonitor } from "./GitMonitor";

function state(branch: string | null, dirtyCount = 0): GitState {
  return { branch, dirtyCount, ahead: 0, behind: 0 };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("GitMonitor", () => {
  test("coalesces the reads asked for while one is in flight", async () => {
    const first = Promise.withResolvers<GitState>();
    const second = Promise.withResolvers<GitState>();
    const reads: Promise<GitState>[] = [];
    const monitor = new GitMonitor({
      status: () => {
        const promise = reads.length === 0 ? first.promise : second.promise;
        reads.push(promise);
        return promise;
      },
    });

    void monitor.refresh("/repo");
    expect(reads).toHaveLength(1);

    void monitor.refresh("/repo");
    void monitor.refresh("/repo");
    expect(reads).toHaveLength(1);

    first.resolve(state("main"));
    await flushPromises();
    expect(reads).toHaveLength(2);

    second.resolve(state("next"));
    await flushPromises();
    expect(reads).toHaveLength(2);
    expect(monitor.stateOf("/repo")).toEqual(state("next"));
  });

  test("tells listeners only what changed, and nothing once they stop", async () => {
    let next = state("main");
    const monitor = new GitMonitor({ status: () => Promise.resolve(next) });
    const heard: GitState[] = [];

    const stop = monitor.watch("/repo", (seen) => {
      heard.push(seen);
    });
    await flushPromises();
    expect(heard).toEqual([state("main")]);

    await monitor.refresh("/repo");
    expect(heard).toHaveLength(1);

    next = state("main", 2);
    await monitor.refresh("/repo");
    expect(heard).toEqual([state("main"), state("main", 2)]);

    stop();
    next = state("other");
    await monitor.refresh("/repo");
    expect(heard).toHaveLength(2);
  });

  test("shares one reader between everyone watching the same directory", async () => {
    let reads = 0;
    const monitor = new GitMonitor({
      status: () => {
        reads += 1;
        return Promise.resolve(state("main"));
      },
    });
    const seen: string[] = [];

    monitor.watch("/repo", () => seen.push("first"));
    monitor.watch("/repo", () => seen.push("second"));
    await flushPromises();

    expect(reads).toBe(1);
    expect(seen).toEqual(["first", "second"]);
  });

  test("refuses a second operation while one is running, and re-reads after it", async () => {
    const held = Promise.withResolvers<void>();
    let next = state("main");
    const monitor = new GitMonitor({ status: () => Promise.resolve(next) });

    const running = monitor.run("/repo", async () => {
      await held.promise;
      next = state("next");
      return { ok: true };
    });
    const refused = await monitor.run("/repo", () =>
      Promise.resolve({ ok: true })
    );

    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.error).toContain("already running");

    held.resolve();
    expect(await running).toEqual({ ok: true });
    expect(monitor.stateOf("/repo")).toEqual(state("next"));
  });

  test("fetches at most once inside the ttl, and never while an operation holds the directory", async () => {
    let fetches = 0;
    const monitor = new GitMonitor({
      status: () => Promise.resolve(Git.EMPTY),
      fetch: () => {
        fetches += 1;
        return Promise.resolve({ ok: true });
      },
      fetchTtlMs: 60_000,
    });

    await monitor.refresh("/repo", { fetch: true });
    await monitor.refresh("/repo", { fetch: true });

    expect(fetches).toBe(1);
  });

  test("survives a read that throws, keeping the state it had", async () => {
    let fail = false;
    const monitor = new GitMonitor({
      status: () =>
        fail
          ? Promise.reject(new Error("no git"))
          : Promise.resolve(state("main")),
    });

    await monitor.refresh("/repo");
    fail = true;

    expect(await monitor.refresh("/repo")).toEqual(state("main"));
  });
});
