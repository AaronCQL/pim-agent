import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { FuzzyMatcher, type FuzzyCandidate } from "../../shared/FuzzyMatcher";

export function rank(
  query: string,
  items: readonly AutocompleteItem[],
  options: { readonly limit?: number } = {}
): AutocompleteItem[] {
  const candidates: FuzzyCandidate<AutocompleteItem>[] = items.map((item) => ({
    item,
    haystacks: [item.label, item.description ?? ""],
  }));

  const hits = FuzzyMatcher.rank(query, candidates, options);

  return hits.map((hit) => hit.item);
}
