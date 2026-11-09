import type { SubagentJobs } from "#core/extensions/subagent/SubagentJobs";
import type { AgentRuntime } from "#core/session/AgentRuntime";
import type { SurfaceName } from "./Surfaces";

/** Process-wide state every surface shares. */
export type SurfaceDeps = {
  readonly runtime: AgentRuntime;
  readonly jobs: SubagentJobs;
};

export type SurfaceHandle = {
  readonly stop: () => Promise<void>;
};

export type Surface = {
  readonly name: SurfaceName;
  /** Resolves once the surface is serving. */
  readonly start: () => Promise<SurfaceHandle>;
};

/** Runs every surface in one process; one failing never stops the others. */
export class Daemon {
  private readonly surfaces: ReadonlyArray<Surface>;
  private readonly jobs: SubagentJobs;
  private readonly live = new Map<SurfaceName, SurfaceHandle>();

  public constructor(surfaces: ReadonlyArray<Surface>, jobs: SubagentJobs) {
    this.surfaces = surfaces;
    this.jobs = jobs;
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

  /** Stops background subagents before any surface disposes the sessions they report to. */
  public async stop(): Promise<void> {
    const live = [...this.live];
    this.live.clear();
    try {
      await this.jobs.stopEverything();
    } catch (err) {
      console.error("[daemon] stopping background subagents failed:", err);
    }
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
