import { basename } from "node:path";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import {
  FuzzyMatcher,
  type FuzzyCandidate,
  type FuzzyIndex,
} from "../../shared/FuzzyMatcher";
import { type FileCandidate, loadAbsolute } from "./catalog";

export type FileRankOptions = {
  readonly cachedRelative: readonly FileCandidate[] | undefined;
  readonly limit?: number;
};

const isAbsoluteQuery = (query: string): boolean =>
  query.startsWith("/") || query.startsWith("~");

let cachedIndex:
  | {
      readonly source: readonly FileCandidate[];
      readonly index: FuzzyIndex<FileCandidate>;
    }
  | undefined;

const indexFor = (
  candidates: readonly FileCandidate[]
): FuzzyIndex<FileCandidate> => {
  if (cachedIndex?.source === candidates) {
    return cachedIndex.index;
  }
  const fuzzy: FuzzyCandidate<FileCandidate>[] = candidates.map(
    (candidate) => ({
      item: candidate,
      haystacks: [candidate.matchHaystack],
    })
  );
  const index = FuzzyMatcher.prepare(fuzzy);
  cachedIndex = { source: candidates, index };
  return index;
};

export async function rank(
  query: string,
  options: FileRankOptions
): Promise<AutocompleteItem[] | undefined> {
  if (isAbsoluteQuery(query)) {
    const { candidates, residualQuery } = await loadAbsolute({ query });
    return rankCandidates(candidates, residualQuery, options.limit);
  }

  if (options.cachedRelative === undefined) {
    return undefined;
  }

  return rankCandidates(options.cachedRelative, query, options.limit);
}

const rankCandidates = (
  candidates: readonly FileCandidate[],
  query: string,
  limit: number | undefined
): AutocompleteItem[] => {
  const hits = indexFor(candidates).find(query, { limit });
  return hits.map((hit) => toItem(hit.item));
};

const toItem = (candidate: FileCandidate): AutocompleteItem => {
  const suffix = candidate.isDirectory ? "/" : "";
  const value = `${candidate.insertPath}${suffix}`;
  const label = `${basename(candidate.insertPath)}${suffix}`;
  return {
    value,
    label,
    description: `${candidate.displayPath}${suffix}`,
  };
};
