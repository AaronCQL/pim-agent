import type { SurfaceName } from "./Surfaces";

/** A running surface, and the only thing the daemon asks of one. */
export type SurfaceHandle = {
  readonly stop: () => Promise<void>;
};

export type Surface = {
  readonly name: SurfaceName;
  /** Brings the surface up, resolving once it is serving rather than when it stops. */
  readonly start: () => Promise<SurfaceHandle>;
};

/**
 * Every surface in one process, and none of them able to take another down: a
 * bot that cannot reach Telegram leaves the browser served, and a port already
 * bound leaves the bot polling.
 */
export class Daemon {
  private readonly surfaces: ReadonlyArray<Surface>;
  private readonly live = new Map<SurfaceName, SurfaceHandle>();

  public constructor(surfaces: ReadonlyArray<Surface>) {
    this.surfaces = surfaces;
  }

  public get running(): ReadonlyArray<SurfaceName> {
    return [...this.live.keys()];
  }

  /** Starts every surface; throws only when none of them came up. */
  public async start(): Promise<ReadonlyArray<SurfaceName>> {
    await Promise.all(
      this.surfaces.map(async (surface) => {
        try {
          this.live.set(surface.name, await surface.start());
        } catch (err) {
          console.error(`[daemon] the ${surface.name} surface failed:`, err);
        }
      })
    );
    if (this.live.size === 0) {
      throw new Error(
        `no surface started: ${this.surfaces.map((surface) => surface.name).join(", ")}`
      );
    }
    return this.running;
  }

  public async stop(): Promise<void> {
    const live = [...this.live];
    this.live.clear();
    await Promise.all(
      live.map(async ([name, handle]) => {
        try {
          await handle.stop();
        } catch (err) {
          console.error(`[daemon] the ${name} surface failed to stop:`, err);
        }
      })
    );
  }
}
