import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SearchBreaker } from "./SearchBreaker";

const paths: string[] = [];

function breakerPath(): string {
  const path = join(tmpdir(), `pim-breaker-${Bun.randomUUIDv7()}.json`);
  paths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { force: true })));
});

const HOUR = 3_600_000;

describe("SearchBreaker", () => {
  test("reports a closed circuit for an unknown provider", async () => {
    expect(await new SearchBreaker({ path: breakerPath() }).isOpen("exa")).toBe(
      false
    );
  });

  test("opens after a trip and persists across instances", async () => {
    const path = breakerPath();
    const now = () => HOUR;

    await new SearchBreaker({ path, now }).trip({
      provider: "exa",
      reason: "daily limit reached",
    });

    expect(await new SearchBreaker({ path, now }).isOpen("exa")).toBe(true);
  });

  test("expires a trip at the next UTC midnight", async () => {
    const path = breakerPath();
    await new SearchBreaker({ path, now: () => HOUR }).trip({
      provider: "exa",
      reason: "daily limit reached",
    });

    const nextDay = new SearchBreaker({ path, now: () => 25 * HOUR });

    expect(await nextDay.isOpen("exa")).toBe(false);
  });

  test("honours a shorter retry-after hint", async () => {
    const path = breakerPath();
    await new SearchBreaker({ path, now: () => HOUR }).trip({
      provider: "duckduckgo",
      reason: "rate limited",
      retryAfterMs: 60_000,
    });

    expect(
      await new SearchBreaker({ path, now: () => HOUR + 30_000 }).isOpen(
        "duckduckgo"
      )
    ).toBe(true);
    expect(
      await new SearchBreaker({ path, now: () => HOUR + 90_000 }).isOpen(
        "duckduckgo"
      )
    ).toBe(false);
  });

  test("lets a probe through once the probe interval elapses", async () => {
    const path = breakerPath();
    await new SearchBreaker({
      path,
      now: () => HOUR,
      probeIntervalMs: 1000,
    }).trip({ provider: "exa", reason: "daily limit reached" });

    expect(
      await new SearchBreaker({ path, now: () => HOUR + 500 }).isOpen("exa")
    ).toBe(true);
    expect(
      await new SearchBreaker({ path, now: () => HOUR + 1500 }).isOpen("exa")
    ).toBe(false);
  });

  test("reset closes the circuit", async () => {
    const path = breakerPath();
    const breaker = new SearchBreaker({ path, now: () => HOUR });
    await breaker.trip({ provider: "exa", reason: "daily limit reached" });

    await breaker.reset("exa");

    expect(await breaker.isOpen("exa")).toBe(false);
  });

  test("ignores unreadable state", async () => {
    const path = breakerPath();
    await Bun.write(path, "{not json");

    expect(await new SearchBreaker({ path }).isOpen("exa")).toBe(false);
  });

  test("keeps providers independent", async () => {
    const path = breakerPath();
    const breaker = new SearchBreaker({ path, now: () => HOUR });

    await breaker.trip({ provider: "exa", reason: "daily limit reached" });

    expect(await breaker.isOpen("exa")).toBe(true);
    expect(await breaker.isOpen("firecrawl")).toBe(false);
  });
});
