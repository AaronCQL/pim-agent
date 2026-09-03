import { Levenshtein } from "./Levenshtein";

export type EditMatchStrategy =
  | "simple"
  | "lineTrimmed"
  | "whitespaceNormalized"
  | "indentationFlexible"
  | "escapeNormalized"
  | "trimmedBoundary"
  | "unicodeNormalized"
  | "blockAnchor"
  | "contextAware";

export type EditRange = readonly [start: number, end: number];

export type ClosestRegion = {
  readonly startLine: number;
  readonly endLine: number;
  readonly similarity: number;
  readonly text: string;
};

export type ResolveOutcome =
  | {
      readonly range: EditRange;
      readonly strategy: EditMatchStrategy;
      readonly matchCount: number;
    }
  | {
      readonly ranges: readonly EditRange[];
      readonly strategy: EditMatchStrategy;
      readonly matchCount: number;
    };

type Candidate = {
  readonly range: EditRange;
  readonly text: string;
};

type Strategy = {
  readonly name: EditMatchStrategy;
  readonly find: (content: string, oldString: string) => readonly Candidate[];
};

function resolve(
  content: string,
  oldString: string,
  replaceAll = false
): ResolveOutcome {
  if (oldString.length === 0) {
    throw new NotFoundError(oldString, findClosestRegions(content, oldString));
  }

  let foundAmbiguous = false;

  for (const strategy of strategies) {
    const candidates = dedupeCandidates(strategy.find(content, oldString));

    if (candidates.length === 0) {
      continue;
    }

    if (replaceAll) {
      return {
        ranges: sortRanges(candidates.map((candidate) => candidate.range)),
        strategy: strategy.name,
        matchCount: candidates.length,
      };
    }

    const unique = candidates.filter((candidate) => {
      const first = content.indexOf(candidate.text);
      const last = content.lastIndexOf(candidate.text);
      return first !== -1 && first === last;
    });

    if (unique.length === 1) {
      return {
        range: unique[0]!.range,
        strategy: strategy.name,
        matchCount: candidates.length,
      };
    }

    foundAmbiguous = true;
  }

  if (foundAmbiguous) {
    throw new MultipleMatchesError(oldString);
  }

  throw new NotFoundError(oldString, findClosestRegions(content, oldString));
}

function applyAll(
  content: string,
  mutations: readonly {
    readonly range: EditRange;
    readonly newString: string;
  }[]
): string {
  let result = content;

  for (const mutation of [...mutations].sort(
    (left, right) => right.range[0] - left.range[0]
  )) {
    result =
      result.slice(0, mutation.range[0]) +
      mutation.newString +
      result.slice(mutation.range[1]);
  }

  return result;
}

function assertNoEscapeDrift(
  strategy: EditMatchStrategy,
  newString: string,
  matchedRegion: string
): void {
  if (strategy === "simple") {
    return;
  }

  const introduced = escapeSequences(newString).filter(
    (sequence) => !matchedRegion.includes(sequence)
  );

  if (introduced.length === 0) {
    return;
  }

  throw new Error(
    `Edit failed: newString contains literal escape text not present in the matched file text: ${[...new Set(introduced)].join(", ")}. Re-read the file and retry using exact file text in oldString and the intended replacement text in newString.`
  );
}

function findClosestRegions(
  content: string,
  oldString: string,
  max = 3,
  threshold = 0.5
): readonly ClosestRegion[] {
  const contentLines = logicalLines(content);
  const searchLines = logicalLines(oldString);
  const windowSize = Math.max(1, searchLines.length);
  const regions: ClosestRegion[] = [];

  if (contentLines.length === 0 || searchLines.length === 0) {
    return [];
  }

  for (let index = 0; index <= contentLines.length - windowSize; index += 1) {
    const window = contentLines.slice(index, index + windowSize);
    let total = 0;

    for (let offset = 0; offset < windowSize; offset += 1) {
      total += lineSimilarity(searchLines[offset] ?? "", window[offset] ?? "");
    }

    const similarity = total / windowSize;

    if (similarity >= threshold) {
      regions.push({
        startLine: index + 1,
        endLine: index + windowSize,
        similarity,
        text: window.join("\n"),
      });
    }
  }

  return regions
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, max);
}

function renderNotFound(error: NotFoundError): string {
  if (error.closest.length === 0) {
    return "oldString was not found in the file.";
  }

  return [
    "oldString was not found in the file. Closest candidate regions:",
    "",
    ...error.closest.flatMap((region, index) => [
      `${index + 1}. lines ${formatLineRange(region.startLine, region.endLine)} (${Math.round(region.similarity * 100)}% similar)`,
      region.text,
    ]),
  ].join("\n");
}

function lineRangeFor(content: string, range: EditRange): string {
  const start = lineNumberAt(content, range[0]);
  const end = lineNumberAt(content, Math.max(range[0], range[1] - 1));
  return formatLineRange(start, end);
}

class NotFoundError extends Error {
  public constructor(
    public readonly oldString: string,
    public readonly closest: readonly ClosestRegion[]
  ) {
    super("oldString was not found in the file.");
    this.name = "NotFoundError";
  }
}

class MultipleMatchesError extends Error {
  public constructor(public readonly oldString: string) {
    super(
      "oldString matched multiple regions. Use enough surrounding context to make oldString unique, or set replaceAll=true to replace all matching oldString."
    );
    this.name = "MultipleMatchesError";
  }
}

function simple(content: string, oldString: string): readonly Candidate[] {
  return findAll(content, oldString);
}

function lineTrimmed(content: string, oldString: string): readonly Candidate[] {
  const contentLines = offsetLines(content);
  const searchLines = logicalLines(oldString);
  const candidates: Candidate[] = [];

  for (
    let index = 0;
    index <= contentLines.length - searchLines.length;
    index += 1
  ) {
    const block = contentLines.slice(index, index + searchLines.length);

    if (
      block.every(
        (line, offset) =>
          line.text.trim() === (searchLines[offset] ?? "").trim()
      )
    ) {
      candidates.push(candidateFromLines(content, block));
    }
  }

  return candidates;
}

function whitespaceNormalized(
  content: string,
  oldString: string
): readonly Candidate[] {
  const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();
  const normalizedFind = normalize(oldString);
  const lines = offsetLines(content);
  const searchLines = logicalLines(oldString);
  const candidates: Candidate[] = [];
  const flexiblePattern = oldString
    .trim()
    .split(/\s+/u)
    .map((word) => escapeRegex(word))
    .join("\\s+");

  for (const line of lines) {
    if (normalize(line.text) === normalizedFind) {
      candidates.push({
        range: [line.start, line.end],
        text: content.slice(line.start, line.end),
      });
      continue;
    }

    if (normalize(line.text).includes(normalizedFind)) {
      const regex = new RegExp(flexiblePattern, "gu");

      for (const match of line.text.matchAll(regex)) {
        if (match.index === undefined) {
          continue;
        }
        const start = line.start + match.index;
        candidates.push({
          range: [start, start + match[0].length],
          text: match[0],
        });
      }
    }
  }

  if (searchLines.length > 1) {
    for (
      let index = 0;
      index <= lines.length - searchLines.length;
      index += 1
    ) {
      const block = lines.slice(index, index + searchLines.length);
      const text = block.map((line) => line.text).join("\n");

      if (normalize(text) === normalizedFind) {
        candidates.push(candidateFromLines(content, block));
      }
    }
  }

  return candidates;
}

function indentationFlexible(
  content: string,
  oldString: string
): readonly Candidate[] {
  const removeIndentation = (text: string): string => {
    const lines = text.split("\n");
    const nonEmpty = lines.filter((line) => line.trim().length > 0);

    if (nonEmpty.length === 0) {
      return text;
    }

    const minIndent = Math.min(
      ...nonEmpty.map((line) => line.match(/^(\s*)/u)?.[1]?.length ?? 0)
    );

    return lines
      .map((line) => (line.trim().length === 0 ? line : line.slice(minIndent)))
      .join("\n");
  };

  const normalizedFind = removeIndentation(oldString);
  const lines = offsetLines(content);
  const searchLines = logicalLines(oldString);
  const candidates: Candidate[] = [];

  for (let index = 0; index <= lines.length - searchLines.length; index += 1) {
    const block = lines.slice(index, index + searchLines.length);
    const text = block.map((line) => line.text).join("\n");

    if (removeIndentation(text) === normalizedFind) {
      candidates.push(candidateFromLines(content, block));
    }
  }

  return candidates;
}

function escapeNormalized(
  content: string,
  oldString: string
): readonly Candidate[] {
  const unescaped = unescapeString(oldString);
  const candidates: Candidate[] = [];
  candidates.push(...findAll(content, unescaped));

  const lines = offsetLines(content);
  const searchLines = logicalLines(unescaped);

  for (let index = 0; index <= lines.length - searchLines.length; index += 1) {
    const block = lines.slice(index, index + searchLines.length);
    const text = block.map((line) => line.text).join("\n");

    if (unescapeString(text) === unescaped) {
      candidates.push(candidateFromLines(content, block));
    }
  }

  return candidates;
}

function trimmedBoundary(
  content: string,
  oldString: string
): readonly Candidate[] {
  const trimmed = oldString.trim();

  if (trimmed === oldString || trimmed.length === 0) {
    return [];
  }

  const candidates = [...findAll(content, trimmed)];
  const lines = offsetLines(content);
  const searchLines = logicalLines(oldString);

  for (let index = 0; index <= lines.length - searchLines.length; index += 1) {
    const block = lines.slice(index, index + searchLines.length);
    const text = block.map((line) => line.text).join("\n");

    if (text.trim() === trimmed) {
      candidates.push(candidateFromLines(content, block));
    }
  }

  return candidates;
}

function unicodeNormalized(
  content: string,
  oldString: string
): readonly Candidate[] {
  // Substitutions in normalizeUnicode must be 1:1 by UTF-16 code unit so offsets in
  // normalizedContent index into the original content. Adding multi-codepoint mappings
  // (e.g. `…` → `...`) here would silently corrupt range math.
  const normalizedContent = normalizeUnicode(content);
  const normalizedOld = normalizeUnicode(oldString);
  const candidates: Candidate[] = [];
  let index = 0;

  while (true) {
    const start = normalizedContent.indexOf(normalizedOld, index);

    if (start === -1) {
      break;
    }

    const end = start + oldString.length;
    candidates.push({ range: [start, end], text: content.slice(start, end) });
    index = Math.max(start + 1, end);
  }

  return candidates;
}

function blockAnchor(content: string, oldString: string): readonly Candidate[] {
  const lines = offsetLines(content);
  const searchLines = logicalLines(oldString);

  if (searchLines.length < 3) {
    return [];
  }

  const first = searchLines[0]?.trim() ?? "";
  const last = searchLines.at(-1)?.trim() ?? "";
  const candidates: Candidate[] = [];

  for (let index = 0; index <= lines.length - searchLines.length; index += 1) {
    const endIndex = index + searchLines.length - 1;

    if (
      lines[index]?.text.trim() !== first ||
      lines[endIndex]?.text.trim() !== last
    ) {
      continue;
    }

    const block = lines.slice(index, endIndex + 1);
    const middleCount = Math.max(1, searchLines.length - 2);
    let similarity = 0;

    for (let offset = 1; offset < searchLines.length - 1; offset += 1) {
      similarity +=
        lineSimilarity(searchLines[offset] ?? "", block[offset]?.text ?? "") /
        middleCount;
    }

    // 0.3 floor filters anchor coincidence on unrelated blocks that happen to share first/last line text.
    if (similarity >= 0.3) {
      candidates.push(candidateFromLines(content, block));
    }
  }

  return candidates;
}

function contextAware(
  content: string,
  oldString: string
): readonly Candidate[] {
  const lines = offsetLines(content);
  const searchLines = logicalLines(oldString);

  if (searchLines.length < 3) {
    return [];
  }

  const first = searchLines[0]?.trim() ?? "";
  const last = searchLines.at(-1)?.trim() ?? "";
  const candidates: Candidate[] = [];

  for (let index = 0; index <= lines.length - searchLines.length; index += 1) {
    const endIndex = index + searchLines.length - 1;

    if (
      lines[index]?.text.trim() !== first ||
      lines[endIndex]?.text.trim() !== last
    ) {
      continue;
    }

    const block = lines.slice(index, endIndex + 1);
    let matching = 0;
    let total = 0;

    for (let offset = 1; offset < searchLines.length - 1; offset += 1) {
      const actual = block[offset]?.text.trim() ?? "";
      const expected = searchLines[offset]?.trim() ?? "";

      if (actual.length > 0 || expected.length > 0) {
        total += 1;
        if (actual === expected) {
          matching += 1;
        }
      }
    }

    if (total === 0 || matching / total >= 0.5) {
      candidates.push(candidateFromLines(content, block));
    }
  }

  return candidates;
}

const strategies: readonly Strategy[] = [
  { name: "simple", find: simple },
  { name: "lineTrimmed", find: lineTrimmed },
  { name: "whitespaceNormalized", find: whitespaceNormalized },
  { name: "indentationFlexible", find: indentationFlexible },
  { name: "escapeNormalized", find: escapeNormalized },
  { name: "trimmedBoundary", find: trimmedBoundary },
  { name: "unicodeNormalized", find: unicodeNormalized },
  { name: "blockAnchor", find: blockAnchor },
  { name: "contextAware", find: contextAware },
];

function findAll(content: string, search: string): readonly Candidate[] {
  const candidates: Candidate[] = [];

  if (search.length === 0) {
    return candidates;
  }

  let index = 0;

  while (true) {
    const start = content.indexOf(search, index);

    if (start === -1) {
      return candidates;
    }

    candidates.push({
      range: [start, start + search.length],
      text: content.slice(start, start + search.length),
    });
    index = Math.max(start + 1, start + search.length);
  }
}

function candidateFromLines(
  content: string,
  lines: readonly OffsetLine[]
): Candidate {
  const first = lines[0];
  const last = lines.at(-1);

  if (first === undefined || last === undefined) {
    return { range: [0, 0], text: "" };
  }

  return {
    range: [first.start, last.end],
    text: content.slice(first.start, last.end),
  };
}

function dedupeCandidates(
  candidates: readonly Candidate[]
): readonly Candidate[] {
  const seen = new Set<string>();
  const deduped: Candidate[] = [];

  for (const candidate of candidates) {
    const key = `${candidate.range[0]}:${candidate.range[1]}`;

    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(candidate);
    }
  }

  return deduped;
}

function sortRanges(ranges: readonly EditRange[]): readonly EditRange[] {
  return [...ranges].sort((left, right) => left[0] - right[0]);
}

function logicalLines(content: string): readonly string[] {
  if (content.length === 0) {
    return [];
  }

  const lines = content.split(/\r?\n/u);

  if (lines.at(-1) === "") {
    lines.pop();
  }

  return lines;
}

function offsetLines(content: string): readonly OffsetLine[] {
  if (content.length === 0) {
    return [];
  }

  const lines: OffsetLine[] = [];
  let start = 0;

  while (start <= content.length) {
    const newline = content.indexOf("\n", start);
    const end = newline === -1 ? content.length : newline;
    const textEnd = end > start && content[end - 1] === "\r" ? end - 1 : end;

    if (start === content.length && newline === -1) {
      break;
    }

    lines.push({
      start,
      end,
      text: content.slice(start, textEnd),
    });

    if (newline === -1) {
      break;
    }

    start = newline + 1;
  }

  if (lines.at(-1)?.text === "" && content.endsWith("\n")) {
    lines.pop();
  }

  return lines;
}

function unescapeString(text: string): string {
  return text.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/gu, (match, value) => {
    switch (value) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "'":
        return "'";
      case '"':
        return '"';
      case "`":
        return "`";
      case "\\":
        return "\\";
      case "\n":
        return "\n";
      case "$":
        return "$";
      default:
        return match;
    }
  });
}

function escapeSequences(text: string): readonly string[] {
  return text.match(/\\(?:n|t|r|'|"|`|\$|\\)/gu) ?? [];
}

function normalizeUnicode(text: string): string {
  return text.replace(/[‘’‚‛“”„‟‐‑‒–—―−   -   　]/gu, (value) => {
    switch (value) {
      case "‘":
      case "’":
      case "‚":
      case "‛":
        return "'";
      case "“":
      case "”":
      case "„":
      case "‟":
        return '"';
      case "‐":
      case "‑":
      case "‒":
      case "–":
      case "—":
      case "―":
      case "−":
        return "-";
      default:
        return " ";
    }
  });
}

function lineSimilarity(left: string, right: string): number {
  const a = left.trim();
  const b = right.trim();
  const max = Math.max(a.length, b.length);

  if (max === 0) {
    return 1;
  }

  return 1 - Levenshtein.distance(a, b) / max;
}

function lineNumberAt(content: string, offset: number): number {
  let line = 1;
  let index = 0;

  while (index < offset) {
    const newline = content.indexOf("\n", index);

    if (newline === -1 || newline >= offset) {
      break;
    }

    line += 1;
    index = newline + 1;
  }

  return line;
}

function formatLineRange(start: number, end: number): string {
  return start === end ? String(start) : `${start}-${end}`;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

type OffsetLine = {
  readonly start: number;
  readonly end: number;
  readonly text: string;
};

export const EditMatcher = {
  resolve,
  applyAll,
  assertNoEscapeDrift,
  findClosestRegions,
  renderNotFound,
  lineRangeFor,
  NotFoundError,
  MultipleMatchesError,
};
