import { DEFAULT_NUM_RESULTS } from "./schema";

export function formatTitle(
  query: string | undefined,
  n: number | undefined = DEFAULT_NUM_RESULTS,
  provider?: string
): string {
  const q = query ?? "...";
  const suffix = provider === undefined ? "" : ` · ${provider}`;
  return `${q} (${n}${suffix})`;
}
