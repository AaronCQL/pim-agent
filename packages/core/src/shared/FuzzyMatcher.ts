import { byLengthAsc, byStartAsc, Fzf } from "fzf";

export type FuzzyCandidate<T> = {
  readonly item: T;
  readonly haystacks: readonly string[];
};

export type FuzzyHit<T> = {
  readonly item: T;
  readonly score: number;
  readonly positions: ReadonlySet<number>;
};

export type FuzzyRankOptions = {
  readonly limit?: number;
};

export type FuzzyIndex<T> = {
  readonly find: (
    query: string,
    options?: FuzzyRankOptions
  ) => readonly FuzzyHit<T>[];
};

const HAYSTACK_SEPARATOR = " ";

function rank<T>(
  query: string,
  candidates: readonly FuzzyCandidate<T>[],
  options: FuzzyRankOptions = {}
): readonly FuzzyHit<T>[] {
  return prepare(candidates).find(query, options);
}

function prepare<T>(candidates: readonly FuzzyCandidate<T>[]): FuzzyIndex<T> {
  const fzf = new Fzf<readonly FuzzyCandidate<T>[]>(candidates, {
    selector: (candidate) => candidate.haystacks.join(HAYSTACK_SEPARATOR),
    tiebreakers: [byStartAsc, byLengthAsc],
  });

  let emptyHits: readonly FuzzyHit<T>[] | undefined;

  return {
    find: (query, options = {}) => {
      const trimmed = query.trim();
      if (trimmed.length === 0) {
        emptyHits ??= [...candidates]
          .sort((a, b) =>
            (a.haystacks[0] ?? "").localeCompare(b.haystacks[0] ?? "")
          )
          .map((candidate) => ({
            item: candidate.item,
            score: 0,
            positions: new Set<number>(),
          }));
        return emptyHits.slice(0, options.limit);
      }
      return fzf
        .find(trimmed)
        .slice(0, options.limit)
        .map((result) => ({
          item: result.item.item,
          score: result.score,
          positions: result.positions,
        }));
    },
  };
}

export const FuzzyMatcher = { rank, prepare };
