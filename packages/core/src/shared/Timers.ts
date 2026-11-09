/** Calls `tick` every `ms` until the returned function is called. */
export type Every = (ms: number, tick: () => void) => () => void;

const GRACE_MS = 3_000;

/** Never keeps the process alive. */
const every: Every = (ms, tick) => {
  const timer = setInterval(tick, ms);
  timer.unref?.();
  return () => clearInterval(timer);
};

/** The few seconds a shutdown waits for in-flight work; never keeps the process alive. */
function grace(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, GRACE_MS).unref?.();
  });
}

export const Timers = { every, grace };
