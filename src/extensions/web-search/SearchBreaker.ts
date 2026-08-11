import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { Fs } from "../../shared/Fs";
import { Paths } from "../../shared/Paths";

type BreakerEntry = {
  readonly until: number;
  readonly nextProbeAt: number;
  readonly reason: string;
};

type BreakerState = Record<string, BreakerEntry>;

export type SearchBreakerOptions = {
  readonly path?: string;
  readonly now?: () => number;
  readonly probeIntervalMs?: number;
};

export type TripInput = {
  readonly provider: string;
  readonly reason: string;
  readonly retryAfterMs?: number;
};

const DAY_MS = 86_400_000;

/**
 * Remembers which providers are quota-exhausted so a dead tier is skipped
 * instead of re-probed on every search. State lives on disk because the
 * Telegram daemon is long-lived and shares an IP-metered quota with any TUI
 * session on the same machine.
 *
 * Exhaustion is per-IP-per-day upstream, so trips default to expiring at the
 * next UTC midnight. A trip can be a false positive (a burst from another
 * process on the same IP), so a sidelined provider is still retried once per
 * probe interval; a rejected probe costs no quota.
 */
export class SearchBreaker {
  private static readonly defaultProbeIntervalMs = 1_800_000;

  private readonly filePath: string;
  private readonly now: () => number;
  private readonly probeIntervalMs: number;
  private writeQueue: Promise<unknown> = Promise.resolve();

  public constructor(options: SearchBreakerOptions = {}) {
    this.filePath =
      options.path ?? join(Paths.pimHomeDir(), "web-search-breaker.json");
    this.now = options.now ?? Date.now;
    this.probeIntervalMs =
      options.probeIntervalMs ?? SearchBreaker.defaultProbeIntervalMs;
  }

  public async isOpen(provider: string): Promise<boolean> {
    const entry = (await this.read())[provider];

    if (entry === undefined) {
      return false;
    }

    const now = this.now();

    return now < entry.until && now < entry.nextProbeAt;
  }

  public async trip(input: TripInput): Promise<void> {
    const now = this.now();
    const ttlMs = input.retryAfterMs ?? msUntilNextUtcMidnight(now);
    const until = now + Math.max(0, ttlMs);

    await this.mutate((state) => ({
      ...state,
      [input.provider]: {
        until,
        nextProbeAt: Math.min(until, now + this.probeIntervalMs),
        reason: input.reason,
      },
    }));
  }

  public async reset(provider: string): Promise<void> {
    const state = await this.read();

    if (state[provider] === undefined) {
      return;
    }

    await this.mutate(({ [provider]: _removed, ...rest }) => rest);
  }

  private async read(): Promise<BreakerState> {
    let raw: unknown;

    try {
      raw = await Bun.file(this.filePath).json();
    } catch {
      return {};
    }

    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return {};
    }

    const now = this.now();
    const state: BreakerState = {};

    for (const [provider, value] of Object.entries(raw)) {
      const entry = parseEntry(value);

      if (entry !== undefined && entry.until > now) {
        state[provider] = entry;
      }
    }

    return state;
  }

  private async mutate(
    update: (state: BreakerState) => BreakerState
  ): Promise<void> {
    const task = async (): Promise<void> => {
      const next = update(await this.read());
      await mkdir(Paths.pimHomeDir(), { recursive: true, mode: 0o700 });
      await chmod(Paths.pimHomeDir(), 0o700);
      await Fs.writeAtomic(
        this.filePath,
        `${JSON.stringify(next, null, 2)}\n`,
        0o600
      );
    };

    this.writeQueue = this.writeQueue.then(task, task);
    await this.writeQueue;
  }
}

function parseEntry(value: unknown): BreakerEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const { until, nextProbeAt, reason } = record;

  if (typeof until !== "number" || typeof nextProbeAt !== "number") {
    return undefined;
  }

  return {
    until,
    nextProbeAt,
    reason: typeof reason === "string" ? reason : "",
  };
}

function msUntilNextUtcMidnight(now: number): number {
  return DAY_MS - (now % DAY_MS);
}
