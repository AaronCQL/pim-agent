import { Shutdown } from "./Shutdown";

const installed = new Set<() => void>();

function install(options: {
  readonly cleanup: () => void;
  readonly intervalMs: number;
}): void {
  const { cleanup, intervalMs } = options;
  if (installed.has(cleanup)) {
    return;
  }
  installed.add(cleanup);

  cleanup();
  setInterval(() => {
    cleanup();
  }, intervalMs).unref?.();
  Shutdown.onExit(cleanup);
}

export const Sweeper = { install };
