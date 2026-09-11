import { basename } from "node:path";
import type { PickerItem } from "./PickerItem";
import {
  FuzzyMatcher,
  type FuzzyCandidate,
  type FuzzyIndex,
} from "../shared/FuzzyMatcher";
import { type FileCandidate, loadAbsolute } from "./catalog";

export type FileRankOptions = {
  readonly cachedRelative: readonly FileCandidate[] | undefined;
  readonly limit?: number;
};

const isAbsoluteQuery = (query: string): boolean =>
  query.startsWith("/") || query.startsWith("~");
const GLOBAL_FUZZY_QUERY_MIN_LENGTH = 3;

const cachedIndexes = new WeakMap<
  readonly FileCandidate[],
  RelativeRankingIndex
>();

const indexFor = (
  candidates: readonly FileCandidate[]
): RelativeRankingIndex => {
  const cached = cachedIndexes.get(candidates);
  if (cached !== undefined) {
    return cached;
  }

  const index = new RelativeRankingIndex(candidates);
  cachedIndexes.set(candidates, index);
  return index;
};

type LoweredCandidate = {
  readonly candidate: FileCandidate;
  readonly haystackLower: string;
  readonly nameStart: number;
};

class RelativeRankingIndex {
  private readonly childrenByDirectory = new Map<string, FileCandidate[]>();
  private readonly loweredSource: readonly LoweredCandidate[];

  private readonly scopedIndexes = new Map<string, FuzzyIndex<FileCandidate>>();
  private globalIndex: FuzzyIndex<FileCandidate> | undefined;

  public constructor(private readonly source: readonly FileCandidate[]) {
    const lowered: LoweredCandidate[] = [];

    for (const candidate of source) {
      const slash = candidate.insertPath.lastIndexOf("/");
      const directory =
        slash === -1 ? "" : candidate.insertPath.slice(0, slash);
      const children = this.childrenByDirectory.get(directory) ?? [];
      children.push(candidate);
      this.childrenByDirectory.set(directory, children);

      lowered.push({
        candidate,
        haystackLower: candidate.matchHaystack.toLocaleLowerCase(),
        nameStart: slash + 1,
      });
    }

    this.loweredSource = lowered;
  }

  public rank(query: string, limit: number | undefined): PickerItem[] {
    const scoped = this.scopedCandidates(query);
    if (scoped !== undefined) {
      return rankCandidates(
        scoped.candidates,
        scoped.residualQuery,
        limit,
        () => this.indexForScope(scoped.directory, scoped.candidates)
      );
    }

    const literalHits = this.literalRank(query, limit);
    if (literalHits !== undefined) {
      return literalHits;
    }

    return rankCandidates(this.source, query, limit, () =>
      this.indexForGlobal()
    );
  }

  private scopedCandidates(query: string):
    | {
        readonly directory: string;
        readonly residualQuery: string;
        readonly candidates: readonly FileCandidate[];
      }
    | undefined {
    const slash = query.lastIndexOf("/");
    if (slash === -1) {
      return undefined;
    }

    const directory = query.slice(0, slash);
    const candidates = this.childrenByDirectory.get(directory);
    if (candidates === undefined) {
      return undefined;
    }

    return {
      directory,
      residualQuery: query.slice(slash + 1),
      candidates,
    };
  }

  private indexForScope(
    directory: string,
    candidates: readonly FileCandidate[]
  ): FuzzyIndex<FileCandidate> {
    const cached = this.scopedIndexes.get(directory);
    if (cached !== undefined) {
      return cached;
    }

    const index = prepareIndex(candidates, (candidate) =>
      basename(candidate.insertPath)
    );
    this.scopedIndexes.set(directory, index);
    return index;
  }

  private indexForGlobal(): FuzzyIndex<FileCandidate> {
    this.globalIndex ??= prepareIndex(
      this.source,
      (candidate) => candidate.matchHaystack
    );
    return this.globalIndex;
  }

  private literalRank(
    query: string,
    limit: number | undefined
  ): PickerItem[] | undefined {
    const needle = query.trim().toLocaleLowerCase();
    if (needle.length === 0 || query.includes("/")) {
      return undefined;
    }

    const prefixHits: FileCandidate[] = [];
    const substringHits: FileCandidate[] = [];
    const limitSize = limit ?? Infinity;

    for (const { candidate, haystackLower, nameStart } of this.loweredSource) {
      if (
        haystackLower.startsWith(needle) ||
        haystackLower.startsWith(needle, nameStart)
      ) {
        prefixHits.push(candidate);
      } else if (
        substringHits.length < limitSize &&
        haystackLower.includes(needle)
      ) {
        substringHits.push(candidate);
      }

      // Only prefix hits may end the scan early: a late prefix must not lose to an earlier substring.
      if (prefixHits.length >= limitSize) {
        break;
      }
    }

    const hitCount = prefixHits.length + substringHits.length;
    if (hitCount === 0) {
      return undefined;
    }

    if (
      prefixHits.length === 0 &&
      needle.length >= GLOBAL_FUZZY_QUERY_MIN_LENGTH &&
      hitCount < limitSize
    ) {
      return undefined;
    }

    return [...prefixHits, ...substringHits]
      .slice(0, limit)
      .map((candidate) => toItem(candidate));
  }
}

export async function rank(
  query: string,
  options: FileRankOptions
): Promise<PickerItem[] | undefined> {
  if (isAbsoluteQuery(query)) {
    const { candidates, residualQuery } = await loadAbsolute({ query });
    return rankCandidates(candidates, residualQuery, options.limit);
  }

  if (options.cachedRelative === undefined) {
    return undefined;
  }

  return indexFor(options.cachedRelative).rank(query, options.limit);
}

const rankCandidates = (
  candidates: readonly FileCandidate[],
  query: string,
  limit: number | undefined,
  index: () => FuzzyIndex<FileCandidate> = () => prepareIndex(candidates)
): PickerItem[] => {
  if (query.trim().length === 0) {
    return candidates.slice(0, limit).map((candidate) => toItem(candidate));
  }

  const hits = index().find(query, { limit });
  return hits.map((hit) => toItem(hit.item));
};

const prepareIndex = (
  candidates: readonly FileCandidate[],
  haystack: (candidate: FileCandidate) => string = (candidate) =>
    candidate.matchHaystack
): FuzzyIndex<FileCandidate> => {
  const fuzzy: FuzzyCandidate<FileCandidate>[] = candidates.map(
    (candidate) => ({
      item: candidate,
      haystacks: [haystack(candidate)],
    })
  );
  return FuzzyMatcher.prepare(fuzzy);
};

const toItem = (candidate: FileCandidate): PickerItem => {
  const suffix = candidate.isDirectory ? "/" : "";
  const value = `${candidate.insertPath}${suffix}`;
  const label = `${basename(candidate.insertPath)}${suffix}`;
  return {
    value,
    label,
    description: `${candidate.displayPath}${suffix}`,
  };
};
