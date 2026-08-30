import type { PickerItem } from "./PickerItem";
import { FuzzyMatcher, type FuzzyCandidate } from "../shared/FuzzyMatcher";

export function rankCommands(
  query: string,
  items: readonly PickerItem[],
  options: { readonly limit?: number } = {}
): PickerItem[] {
  const candidates: FuzzyCandidate<PickerItem>[] = items.map((item) => ({
    item,
    haystacks: [item.label, item.description ?? ""],
  }));

  const hits = FuzzyMatcher.rank(query, candidates, options);

  return hits.map((hit) => hit.item);
}
