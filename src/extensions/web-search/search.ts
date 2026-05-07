import type { ExaSearchResult } from "./ExaMcpClient";
import {
  DEFAULT_NUM_RESULTS,
  MAX_NUM_RESULTS,
  MIN_NUM_RESULTS,
} from "./schema";

export function clampNumResults(value: number | undefined): number {
  const requested = value ?? DEFAULT_NUM_RESULTS;
  return Math.min(MAX_NUM_RESULTS, Math.max(MIN_NUM_RESULTS, requested));
}

export function formatResults(results: readonly ExaSearchResult[]): string {
  return results
    .map((result) =>
      [
        `title: ${result.title}`,
        `url: ${result.url}`,
        `snippet: ${result.snippet}`,
      ].join("\n")
    )
    .join("\n\n");
}
