export type RateLimiterOptions = {
  readonly maxRequests: number;
  readonly windowMs: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
};

export class RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timestamps: number[] = [];
  private tail: Promise<void> = Promise.resolve();

  public constructor(options: RateLimiterOptions) {
    this.maxRequests = Math.max(1, options.maxRequests);
    this.windowMs = options.windowMs;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
  }

  public acquire(): Promise<void> {
    const reserved = this.tail.then(() => this.reserve());
    this.tail = reserved.catch(() => {});

    return reserved;
  }

  private async reserve(): Promise<void> {
    while (true) {
      const now = this.now();
      const threshold = now - this.windowMs;

      while (this.timestamps.length > 0 && this.timestamps[0]! <= threshold) {
        this.timestamps.shift();
      }

      if (this.timestamps.length < this.maxRequests) {
        this.timestamps.push(now);

        return;
      }

      const waitMs = this.timestamps[0]! + this.windowMs - now;

      await this.sleep(Math.max(0, waitMs));
    }
  }
}
