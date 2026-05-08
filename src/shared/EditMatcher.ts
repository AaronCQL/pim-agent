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

export class EditMatcher {
  public static resolve(
    content: string,
    oldString: string,
    replaceAll = false
  ): ResolveOutcome {
    if (oldString.length === 0) {
      throw new EditMatcher.NotFoundError(
        oldString,
        EditMatcher.findClosestRegions(content, oldString)
      );
    }

    let foundAmbiguous = false;

    for (const strategy of EditMatcher.strategies) {
      const candidates = EditMatcher.dedupeCandidates(
        strategy.find(content, oldString)
      );

      if (candidates.length === 0) {
        continue;
      }

      if (replaceAll) {
        return {
          ranges: EditMatcher.sortRanges(
            candidates.map((candidate) => candidate.range)
          ),
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
      throw new EditMatcher.MultipleMatchesError(oldString);
    }

    throw new EditMatcher.NotFoundError(
      oldString,
      EditMatcher.findClosestRegions(content, oldString)
    );
  }

  public static applyAll(
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

  public static assertNoEscapeDrift(
    strategy: EditMatchStrategy,
    newString: string,
    matchedRegion: string
  ): void {
    if (strategy === "simple") {
      return;
    }

    const introduced = EditMatcher.escapeSequences(newString).filter(
      (sequence) => !matchedRegion.includes(sequence)
    );

    if (introduced.length === 0) {
      return;
    }

    throw new Error(
      `[E_ESCAPE_DRIFT] Fuzzy edit matched with strategy "${strategy}", but newString introduces escape sequences not present in the matched region: ${[...new Set(introduced)].join(", ")}. Re-read the file and submit literal replacement text.`
    );
  }

  public static findClosestRegions(
    content: string,
    oldString: string,
    max = 3,
    threshold = 0.5
  ): readonly ClosestRegion[] {
    const contentLines = EditMatcher.logicalLines(content);
    const searchLines = EditMatcher.logicalLines(oldString);
    const windowSize = Math.max(1, searchLines.length);
    const regions: ClosestRegion[] = [];

    if (contentLines.length === 0 || searchLines.length === 0) {
      return [];
    }

    for (let index = 0; index <= contentLines.length - windowSize; index += 1) {
      const window = contentLines.slice(index, index + windowSize);
      let total = 0;

      for (let offset = 0; offset < windowSize; offset += 1) {
        total += EditMatcher.lineSimilarity(
          searchLines[offset] ?? "",
          window[offset] ?? ""
        );
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

  public static renderNotFound(
    error: InstanceType<typeof EditMatcher.NotFoundError>
  ): string {
    if (error.closest.length === 0) {
      return "[E_NOT_FOUND] oldString was not found in the file.";
    }

    return [
      "[E_NOT_FOUND] oldString was not found in the file. Closest candidate regions:",
      "",
      ...error.closest.flatMap((region, index) => [
        `${index + 1}. lines ${EditMatcher.formatLineRange(region.startLine, region.endLine)} (${Math.round(region.similarity * 100)}% similar)`,
        region.text,
      ]),
    ].join("\n");
  }

  public static lineRangeFor(content: string, range: EditRange): string {
    const start = EditMatcher.lineNumberAt(content, range[0]);
    const end = EditMatcher.lineNumberAt(
      content,
      Math.max(range[0], range[1] - 1)
    );
    return EditMatcher.formatLineRange(start, end);
  }

  public static readonly NotFoundError = class NotFoundError extends Error {
    public constructor(
      public readonly oldString: string,
      public readonly closest: readonly ClosestRegion[]
    ) {
      super("oldString was not found in the file.");
      this.name = "NotFoundError";
    }
  };

  public static readonly MultipleMatchesError = class MultipleMatchesError extends Error {
    public constructor(public readonly oldString: string) {
      super(
        "[E_MULTIPLE_MATCHES] oldString matched multiple regions. Use enough surrounding context to make oldString unique, or set replaceAll=true."
      );
      this.name = "MultipleMatchesError";
    }
  };

  private static readonly strategies: readonly Strategy[] = [
    {
      name: "simple",
      find: (content, oldString) => EditMatcher.simple(content, oldString),
    },
    {
      name: "lineTrimmed",
      find: (content, oldString) => EditMatcher.lineTrimmed(content, oldString),
    },
    {
      name: "whitespaceNormalized",
      find: (content, oldString) =>
        EditMatcher.whitespaceNormalized(content, oldString),
    },
    {
      name: "indentationFlexible",
      find: (content, oldString) =>
        EditMatcher.indentationFlexible(content, oldString),
    },
    {
      name: "escapeNormalized",
      find: (content, oldString) =>
        EditMatcher.escapeNormalized(content, oldString),
    },
    {
      name: "trimmedBoundary",
      find: (content, oldString) =>
        EditMatcher.trimmedBoundary(content, oldString),
    },
    {
      name: "unicodeNormalized",
      find: (content, oldString) =>
        EditMatcher.unicodeNormalized(content, oldString),
    },
    {
      name: "blockAnchor",
      find: (content, oldString) => EditMatcher.blockAnchor(content, oldString),
    },
    {
      name: "contextAware",
      find: (content, oldString) =>
        EditMatcher.contextAware(content, oldString),
    },
  ];

  private static simple(
    content: string,
    oldString: string
  ): readonly Candidate[] {
    return EditMatcher.findAll(content, oldString);
  }

  private static lineTrimmed(
    content: string,
    oldString: string
  ): readonly Candidate[] {
    const contentLines = EditMatcher.offsetLines(content);
    const searchLines = EditMatcher.logicalLines(oldString);
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
        candidates.push(EditMatcher.candidateFromLines(content, block));
      }
    }

    return candidates;
  }

  private static whitespaceNormalized(
    content: string,
    oldString: string
  ): readonly Candidate[] {
    const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();
    const normalizedFind = normalize(oldString);
    const lines = EditMatcher.offsetLines(content);
    const searchLines = EditMatcher.logicalLines(oldString);
    const candidates: Candidate[] = [];
    const flexiblePattern = oldString
      .trim()
      .split(/\s+/u)
      .map((word) => EditMatcher.escapeRegex(word))
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
          candidates.push(EditMatcher.candidateFromLines(content, block));
        }
      }
    }

    return candidates;
  }

  private static indentationFlexible(
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
        .map((line) =>
          line.trim().length === 0 ? line : line.slice(minIndent)
        )
        .join("\n");
    };

    const normalizedFind = removeIndentation(oldString);
    const lines = EditMatcher.offsetLines(content);
    const searchLines = EditMatcher.logicalLines(oldString);
    const candidates: Candidate[] = [];

    for (
      let index = 0;
      index <= lines.length - searchLines.length;
      index += 1
    ) {
      const block = lines.slice(index, index + searchLines.length);
      const text = block.map((line) => line.text).join("\n");

      if (removeIndentation(text) === normalizedFind) {
        candidates.push(EditMatcher.candidateFromLines(content, block));
      }
    }

    return candidates;
  }

  private static escapeNormalized(
    content: string,
    oldString: string
  ): readonly Candidate[] {
    const unescaped = EditMatcher.unescapeString(oldString);
    const candidates: Candidate[] = [];
    candidates.push(...EditMatcher.findAll(content, unescaped));

    const lines = EditMatcher.offsetLines(content);
    const searchLines = EditMatcher.logicalLines(unescaped);

    for (
      let index = 0;
      index <= lines.length - searchLines.length;
      index += 1
    ) {
      const block = lines.slice(index, index + searchLines.length);
      const text = block.map((line) => line.text).join("\n");

      if (EditMatcher.unescapeString(text) === unescaped) {
        candidates.push(EditMatcher.candidateFromLines(content, block));
      }
    }

    return candidates;
  }

  private static trimmedBoundary(
    content: string,
    oldString: string
  ): readonly Candidate[] {
    const trimmed = oldString.trim();

    if (trimmed === oldString || trimmed.length === 0) {
      return [];
    }

    const candidates = [...EditMatcher.findAll(content, trimmed)];
    const lines = EditMatcher.offsetLines(content);
    const searchLines = EditMatcher.logicalLines(oldString);

    for (
      let index = 0;
      index <= lines.length - searchLines.length;
      index += 1
    ) {
      const block = lines.slice(index, index + searchLines.length);
      const text = block.map((line) => line.text).join("\n");

      if (text.trim() === trimmed) {
        candidates.push(EditMatcher.candidateFromLines(content, block));
      }
    }

    return candidates;
  }

  private static unicodeNormalized(
    content: string,
    oldString: string
  ): readonly Candidate[] {
    // Substitutions in normalizeUnicode must be 1:1 by UTF-16 code unit so offsets in
    // normalizedContent index into the original content. Adding multi-codepoint mappings
    // (e.g. `…` → `...`) here would silently corrupt range math.
    const normalizedContent = EditMatcher.normalizeUnicode(content);
    const normalizedOld = EditMatcher.normalizeUnicode(oldString);
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

  private static blockAnchor(
    content: string,
    oldString: string
  ): readonly Candidate[] {
    const lines = EditMatcher.offsetLines(content);
    const searchLines = EditMatcher.logicalLines(oldString);

    if (searchLines.length < 3) {
      return [];
    }

    const first = searchLines[0]?.trim() ?? "";
    const last = searchLines.at(-1)?.trim() ?? "";
    const candidates: Candidate[] = [];

    for (
      let index = 0;
      index <= lines.length - searchLines.length;
      index += 1
    ) {
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
          EditMatcher.lineSimilarity(
            searchLines[offset] ?? "",
            block[offset]?.text ?? ""
          ) / middleCount;
      }

      // 0.3 floor filters anchor coincidence on unrelated blocks that happen to share first/last line text.
      if (similarity >= 0.3) {
        candidates.push(EditMatcher.candidateFromLines(content, block));
      }
    }

    return candidates;
  }

  private static contextAware(
    content: string,
    oldString: string
  ): readonly Candidate[] {
    const lines = EditMatcher.offsetLines(content);
    const searchLines = EditMatcher.logicalLines(oldString);

    if (searchLines.length < 3) {
      return [];
    }

    const first = searchLines[0]?.trim() ?? "";
    const last = searchLines.at(-1)?.trim() ?? "";
    const candidates: Candidate[] = [];

    for (
      let index = 0;
      index <= lines.length - searchLines.length;
      index += 1
    ) {
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
        candidates.push(EditMatcher.candidateFromLines(content, block));
      }
    }

    return candidates;
  }

  private static findAll(
    content: string,
    search: string
  ): readonly Candidate[] {
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

  private static candidateFromLines(
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

  private static dedupeCandidates(
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

  private static sortRanges(
    ranges: readonly EditRange[]
  ): readonly EditRange[] {
    return [...ranges].sort((left, right) => left[0] - right[0]);
  }

  private static logicalLines(content: string): readonly string[] {
    if (content.length === 0) {
      return [];
    }

    const lines = content.split(/\r?\n/u);

    if (lines.at(-1) === "") {
      lines.pop();
    }

    return lines;
  }

  private static offsetLines(content: string): readonly OffsetLine[] {
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

  private static unescapeString(text: string): string {
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

  private static escapeSequences(text: string): readonly string[] {
    return text.match(/\\(?:n|t|r|'|"|`|\$|\\)/gu) ?? [];
  }

  private static normalizeUnicode(text: string): string {
    return text.replace(/[‘’‚‛“”„‟‐‑‒–—―−   -   　]/gu, (value) => {
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

  private static lineSimilarity(left: string, right: string): number {
    const a = left.trim();
    const b = right.trim();
    const max = Math.max(a.length, b.length);

    if (max === 0) {
      return 1;
    }

    return 1 - EditMatcher.levenshtein(a, b) / max;
  }

  private static levenshtein(left: string, right: string): number {
    if (left.length === 0 || right.length === 0) {
      return Math.max(left.length, right.length);
    }

    let previous = Array.from(
      { length: right.length + 1 },
      (_, index) => index
    );
    let current = Array.from({ length: right.length + 1 }, () => 0);

    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      current[0] = leftIndex;

      for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
        const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
        current[rightIndex] = Math.min(
          previous[rightIndex]! + 1,
          current[rightIndex - 1]! + 1,
          previous[rightIndex - 1]! + cost
        );
      }

      [previous, current] = [current, previous];
    }

    return previous[right.length] ?? 0;
  }

  private static lineNumberAt(content: string, offset: number): number {
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

  private static formatLineRange(start: number, end: number): string {
    return start === end ? String(start) : `${start}-${end}`;
  }

  private static escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }
}

type OffsetLine = {
  readonly start: number;
  readonly end: number;
  readonly text: string;
};
