import type { ProbeClient } from "../ProbeClient";

export function sessionOf(probe: ProbeClient): string {
  const sessionId = probe.sessionId;
  if (sessionId === undefined) {
    throw new Error("the probe never attached");
  }
  return sessionId;
}
