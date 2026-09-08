import { Supervisor } from "#core/shared/Supervisor";
import { Updater, type UpdateOutcome } from "#core/shared/Updater";
import type { ServerEvent } from "#protocol/ServerEvent";
import { WebUnit } from "./WebUnit";

export type ReloaderDeps = {
  /** To every connection: the restart takes all of them down together. */
  readonly announce: (event: ServerEvent) => void;
  /** Runs the update, reporting each step as it starts. */
  readonly update?: (onStep: (label: string) => void) => Promise<UpdateOutcome>;
  /** Takes this process down so the supervisor puts the new code up in its place. */
  readonly shutdown?: () => Promise<void>;
};

// Re-raise SIGTERM rather than exiting: the handler stops the gateway and flushes the read cursors.
async function restartAndExit(): Promise<void> {
  await Supervisor.restartSiblings(WebUnit.descriptor);
  process.kill(process.pid, "SIGTERM");
}

/** Runs the update-restart-return an operator asked for, announcing each phase. */
export class Reloader {
  private readonly announce: (event: ServerEvent) => void;
  private readonly update: (
    onStep: (label: string) => void
  ) => Promise<UpdateOutcome>;
  private readonly shutdown: () => Promise<void>;
  private running: Promise<void> | undefined;

  public constructor(deps: ReloaderDeps) {
    this.announce = deps.announce;
    this.update = deps.update ?? ((onStep) => Updater.run({ onStep }));
    this.shutdown = deps.shutdown ?? restartAndExit;
    this.running = undefined;
  }

  /** The run already in flight, or a new one; two callers share one install. */
  public start(): Promise<void> {
    this.running ??= this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async run(): Promise<void> {
    let outcome: UpdateOutcome;
    try {
      outcome = await this.update((label) => {
        this.announce({ type: "update_state", phase: "step", label });
      });
    } catch (err) {
      this.failed(messageOf(err));
      return;
    }
    if (!outcome.ok) {
      this.failed(outcome.error ?? "the update failed");
      return;
    }
    const { from, to, skipped } = outcome;
    // Unsupervised, exiting would end this process rather than replace it.
    if (!Supervisor.isSupervised()) {
      this.announce({
        type: "update_state",
        phase: "stranded",
        from,
        to,
        skipped,
      });
      return;
    }
    this.announce({
      type: "update_state",
      phase: "restarting",
      from,
      to,
      skipped,
    });
    try {
      await this.shutdown();
    } catch (err) {
      // Must follow the `restarting` frame: it corrects a client already told to expect the drop.
      this.failed(messageOf(err));
    }
  }

  private failed(error: string): void {
    this.announce({ type: "update_state", phase: "failed", error });
  }
}

function messageOf(err: unknown): string {
  return (err as Error).message ?? String(err);
}
