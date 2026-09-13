const POLL_MS = 1;

/**
 * Polls until `test` holds, naming the wait rather than being killed by the
 * runner. These waits are over a real gateway, a real agent and real git, any
 * of which stalls for seconds on a shared runner — so the default is a
 * diagnosis, not a guess at the machine's speed, and `check.ts` gives the
 * suite a per-test timeout above it.
 */
export async function until(
  test: () => boolean,
  label: string,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!test()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await Bun.sleep(POLL_MS);
  }
}
