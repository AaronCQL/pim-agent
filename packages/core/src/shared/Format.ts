function formatTokens(tokens: number): string {
  if (tokens < 1000) {
    return `${tokens}`;
  }
  if (tokens < 10_000) {
    return `${(tokens / 1000).toFixed(1)}K`;
  }
  if (tokens < 1_000_000) {
    return `${Math.round(tokens / 1000)}K`;
  }
  if (tokens < 10_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1_000_000)}M`;
}

/**
 * A duration as the running indicator says it: `32s`, `1m 32s`, `1h 1m 32s`.
 * Shared because the TUI's `Clanking…` line and the web's are the same line.
 */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}h ${minutes}m ${seconds}s`
    : minutes > 0
      ? `${minutes}m ${seconds}s`
      : `${seconds}s`;
}

/** How full the context window reads, as a verdict each frontend colours. */
export type ContextFill = "ok" | "warn" | "full";

/**
 * Shared so the TUI footer and the web's context pill turn amber at the same
 * fill; the two palettes differ, the thresholds must not.
 */
function contextFill(percent: number): ContextFill {
  if (percent >= 70) {
    return "full";
  }
  return percent > 40 ? "warn" : "ok";
}

export const Format = { formatTokens, formatElapsed, contextFill };
