import { DEFAULT_NUM_RESULTS } from "./schema";

export function formatTitle(
  query: string | undefined,
  n: number | undefined
): string {
  const q = query ?? "...";
  if (n === undefined || n === DEFAULT_NUM_RESULTS) {
    return q;
  }
  return `${q} (${n})`;
}
