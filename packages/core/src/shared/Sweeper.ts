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
  process.once("exit", () => {
    cleanup();
  });

  // Signals skip the "exit" handler; re-raise after the once-handler, or the default exit is suppressed.
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
