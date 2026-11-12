import { constants } from "node:os";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export type FatalSignal = (typeof SIGNALS)[number];

const hooks = new Set<() => void>();
let exitHooked = false;

/**
 * Runs `hook` synchronously as the process exits; registering it again is a no-op.
 * A signal reaches it only through the process's signal owner exiting, so libraries
 * register here and never handle signals themselves.
 */
function onExit(hook: () => void): void {
  hooks.add(hook);
  if (!exitHooked) {
    exitHooked = true;
    process.on("exit", runHooks);
  }
}

function runHooks(): void {
  for (const hook of hooks) {
    try {
      hook();
    } catch {}
  }
}

function exitCode(signal: FatalSignal): number {
  return 128 + constants.signals[signal];
}

/** Makes the caller the signal owner: resolves on the first fatal signal, and any later one exits at once. */
function untilSignal(): Promise<FatalSignal> {
  const first = Promise.withResolvers<FatalSignal>();
  let received = false;
  for (const signal of SIGNALS) {
    process.on(signal, () => {
      if (received) {
        process.exit(exitCode(signal));
      }
      received = true;
      first.resolve(signal);
    });
  }
  return first.promise;
}

/**
 * Makes the caller the owner of `signals`, each exiting at once with its conventional code.
 * Like Node's default action, it yields to any listener added after it, such as pi's suspend guard.
 */
function exitOn(signals: readonly FatalSignal[]): void {
  for (const signal of signals) {
    const earlier = new Set(process.listeners(signal));
    const exit = (): void => {
      const claimed = process
        .listeners(signal)
        .some((listener) => listener !== exit && !earlier.has(listener));
      if (!claimed) {
        process.exit(exitCode(signal));
      }
    };
    process.on(signal, exit);
  }
}

/** Asks this process's signal owner for its graceful stop. */
function requestStop(): void {
  process.kill(process.pid, "SIGTERM");
}

export const Shutdown = {
  onExit,
  untilSignal,
  exitOn,
  requestStop,
};
