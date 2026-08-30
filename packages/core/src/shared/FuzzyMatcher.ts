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

export class FuzzyMatcher {
  public static rank<T>(
    query: string,
    candidates: readonly FuzzyCandidate<T>[],
    options: FuzzyRankOptions = {}
  ): readonly FuzzyHit<T>[] {
    return FuzzyMatcher.prepare(candidates).find(query, options);
  }

  public static prepare<T>(
    candidates: readonly FuzzyCandidate<T>[]
  ): FuzzyIndex<T> {
    const fzf = new Fzf<readonly FuzzyCandidate<T>[]>(candidates, {
      selector: (candidate) => candidate.haystacks.join(HAYSTACK_SEPARATOR),
      tiebreakers: [byStartAsc, byLengthAsc],
    });

    let emptyHits: readonly FuzzyHit<T>[] | undefined;

    return {
      find: (query, options = {}) => {
        const trimmed = query.trim();
        const limit = options.limit ?? Infinity;
        if (trimmed.length === 0) {
          if (emptyHits === undefined) {
            emptyHits = [...candidates]
              .sort((a, b) =>
                (a.haystacks[0] ?? "").localeCompare(b.haystacks[0] ?? "")
              )
              .map((candidate) => ({
                item: candidate.item,
                score: 0,
                positions: new Set<number>(),
              }));
          }
          return limit === Infinity ? emptyHits : emptyHits.slice(0, limit);
        }
        const hits = fzf.find(trimmed).map((result) => ({
          item: result.item.item,
          score: result.score,
          positions: result.positions,
        }));
        return limit === Infinity ? hits : hits.slice(0, limit);
      },
    };
  }
}
