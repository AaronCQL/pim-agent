import { Supervisor } from "#core/shared/Supervisor";
import { Updater, type UpdateOutcome } from "#core/shared/Updater";
import type { ServerEvent } from "#protocol/ServerEvent";
import { WebUnit } from "./WebUnit";

export type ReloaderDeps = {
  /** To every connection: the restart takes all of them down together. */
  readonly announce: (event: ServerEvent) => void;
  /**
   * Runs the update, reporting each step as it starts. Injectable because the
   * real one spawns `bun install` against the tree the caller is running from.
   */
  readonly update?: (onStep: (label: string) => void) => Promise<UpdateOutcome>;
  /**
   * Takes this process down so the supervisor puts the new code up in its
   * place. Injectable for the same reason: nothing under test may signal the
   * runner or kick a real daemon.
   */
  readonly shutdown?: () => Promise<void>;
};

/**
 * The other pim daemons run from the tree that was just replaced, so they go
 * first; this one goes by re-raising the signal it already shuts down on.
 *
 * Deliberately a signal and not `Supervisor.restart()`: exiting straight from
 * here would skip the handler that stops the gateway, and the read cursors
 * taken during the run are flushed by that stop. One shutdown path, whether
 * the operator asked for it or systemd did.
 */
async function restartAndExit(): Promise<void> {
  await Supervisor.restartSiblings(WebUnit.descriptor);
  process.kill(process.pid, "SIGTERM");
}

/**
 * Runs the "update, restart, and come back" the operator asked for, and says
 * what it is doing while it does it.
 *
 * Its own object rather than more of the gateway: the gateway is about
 * sockets and sessions and knows nothing else about the machine it runs on,
 * whereas this spawns installs, restarts daemons and ends the process. The
 * one thing they share is fanout, which arrives here as a callback.
 */
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

  /**
   * The run already in flight, or a new one. Two operators clicking at once
   * are one install: a second would race the first over the same tree, and
   * both of them are asking for the same single thing — the latest code.
   */
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
    // Nothing is watching this process, so exiting would end it rather than
    // replace it: the new code is on disk, the old code is still the code
    // answering, and only the operator can close that gap.
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
      // After the restarting frame on purpose: a client has just been told
      // its socket is about to drop, and now it is not going to, so the
      // correction has to reach it before it settles in to wait for a server
      // that is never coming.
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
