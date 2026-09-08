const installed = new Set<() => void>();

/**
 * Idempotent per cleanup function: registers the retention lifecycle (startup
 * sweep, periodic sweep, and cleanup on exit/termination) once, however many
 * times it is called.
 */
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
  process.once("exit", () => {
    cleanup();
  });

  // Signal-induced termination skips the "exit" handler, so sweep here too.
  // Re-raise after our once-handler is gone so the default termination still
  // happens — merely registering a signal listener otherwise suppresses it.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.once(sig, () => {
      try {
        cleanup();
      } catch {}
      process.kill(process.pid, sig);
    });
  }
}

export const Sweeper = { install };
