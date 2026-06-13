import { FileScanner, type FileScanOptions } from "../../shared/FileScanner";
import { FsErrors } from "../../shared/FsErrors";
import { Lines } from "../../shared/Lines";

const MATCH_CONCURRENCY = 16;

export type GrepLine = {
  readonly lineNumber: number;
  readonly text: string;
};

export type GrepLineRange = {
  readonly startLineNumber: number;
  readonly endLineNumber: number;
};

export type GrepMatch = {
  readonly filePath: string;
  readonly mtime: number;
  readonly lines: readonly GrepLine[];
  readonly ranges: readonly GrepLineRange[];
  readonly fileLines: readonly string[];
};

export type GrepMatcher = {
  readonly regex: RegExp;
  readonly matchAcrossLines: boolean;
  /**
   * Raw-byte needle for the literal fast path: present only when the pattern is
   * a pure literal, case-sensitive, and single-line, so `matchFile` can reject a
   * non-matching file with `Buffer.indexOf` before decoding it. Undefined
   * otherwise, in which case the regex path runs unchanged.
   */
  readonly literal: Buffer | undefined;
};

export type GrepScanOptions = FileScanOptions;

// Characters that stand for themselves in both a default-flag regex and raw
// UTF-8 bytes (all ASCII, so they never alias a multibyte sequence). A pattern
// made only of these is a literal we can scan on bytes.
const PURE_LITERAL = /^[A-Za-z0-9_ \-/]+$/;

function literalNeedle(
  pattern: string,
  caseInsensitive: boolean,
  matchAcrossLines: boolean
): Buffer | undefined {
  if (caseInsensitive || matchAcrossLines || !PURE_LITERAL.test(pattern)) {
    return undefined;
  }
  return Buffer.from(pattern, "utf8");
}

export function buildMatcher(options: {
  readonly pattern: string;
  readonly caseInsensitive: boolean;
  readonly matchAcrossLines: boolean;
}): GrepMatcher {
  const flags = `${options.matchAcrossLines ? "s" : ""}${
    options.caseInsensitive ? "i" : ""
  }`;

  try {
    return {
      regex: new RegExp(options.pattern, flags),
      matchAcrossLines: options.matchAcrossLines,
      literal: literalNeedle(
        options.pattern,
        options.caseInsensitive,
        options.matchAcrossLines
      ),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid regular expression /${options.pattern}/${flags}: ${message}. Escape regex metacharacters for a literal search or simplify the pattern.`
    );
  }
}

export async function findMatches(
  path: string,
  glob: string | undefined,
  matcher: GrepMatcher,
  options: GrepScanOptions
): Promise<readonly GrepMatch[]> {
  const metadata = await FsErrors.statOrThrow(path);
  const files = metadata.isFile()
    ? [path]
    : (await FileScanner.scan(path, glob ?? "**/*", options)).toSorted(
        comparePaths
      );
  const results: GrepMatch[] = [];

  for (let index = 0; index < files.length; index += MATCH_CONCURRENCY) {
    const chunk = files.slice(index, index + MATCH_CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map((filePath) => matchFile(filePath, matcher))
    );

    for (const match of chunkResults) {
      if (match !== undefined) {
        results.push(match);
      }
    }
  }

  return results;
}

async function matchFile(
  filePath: string,
  matcher: GrepMatcher
): Promise<GrepMatch | undefined> {
  const file = Bun.file(filePath);

  // Binary skip reads only the first 8KB, so a binary file is never fully read.
  if (await Lines.isBinary(file)) {
    return undefined;
  }

  let text: string;
  if (matcher.literal !== undefined) {
    // Literal fast path: scan raw bytes and bail on a miss without decoding. An
    // ASCII literal can't match across a normalized newline or alias a
    // multibyte char, so a raw-byte hit/miss matches the decoded result.
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.indexOf(matcher.literal) < 0) {
      return undefined;
    }
    text = bytes.toString("utf8");
  } else {
    text = await file.text();
  }

  const content = Lines.normalize(text);
  const fileLines = Lines.split(content);
  const ranges = matcher.matchAcrossLines
    ? regexRanges(content, matcher.regex)
    : matchLineByLine(fileLines, matcher.regex);

  if (ranges.length === 0) {
    return undefined;
  }

  return {
    filePath,
    mtime: file.lastModified,
    lines: linesForRanges(fileLines, ranges),
    ranges,
    fileLines,
  };
}

function matchLineByLine(
  lines: readonly string[],
  regex: RegExp
): readonly GrepLineRange[] {
  const ranges: GrepLineRange[] = [];

  for (const [index, line] of lines.entries()) {
    if (regex.test(line)) {
      const lineNumber = index + 1;
      ranges.push({ startLineNumber: lineNumber, endLineNumber: lineNumber });
    }
  }

  return ranges;
}

function regexRanges(content: string, regex: RegExp): readonly GrepLineRange[] {
  const globalRegex = new RegExp(regex.source, addFlag(regex.flags, "g"));
  const ranges: GrepLineRange[] = [];

  while (true) {
    const match = globalRegex.exec(content);

    if (match === null) {
      break;
    }

    ranges.push(
      lineRangeForOffsets(content, match.index, match.index + match[0].length)
    );

    if (match[0].length === 0) {
      globalRegex.lastIndex += 1;
    }
  }

  return ranges;
}

function addFlag(flags: string, flag: string): string {
  return flags.includes(flag) ? flags : `${flags}${flag}`;
}

function lineRangeForOffsets(
  content: string,
  startOffset: number,
  endOffset: number
): GrepLineRange {
  return {
    startLineNumber: lineNumberForOffset(content, startOffset),
    endLineNumber: lineNumberForOffset(
      content,
      Math.max(startOffset, endOffset - 1)
    ),
  };
}

function lineNumberForOffset(content: string, offset: number): number {
  let lineNumber = 1;

  for (let index = 0; index < offset && index < content.length; index += 1) {
    if (content[index] === "\n") {
      lineNumber += 1;
    }
  }

  return lineNumber;
}

function linesForRanges(
  fileLines: readonly string[],
  ranges: readonly GrepLineRange[]
): readonly GrepLine[] {
  const seen = new Set<number>();
  const lines: GrepLine[] = [];

  for (const range of ranges) {
    for (
      let lineNumber = range.startLineNumber;
      lineNumber <= range.endLineNumber;
      lineNumber += 1
    ) {
      if (seen.has(lineNumber)) {
        continue;
      }

      seen.add(lineNumber);
      lines.push({ lineNumber, text: fileLines[lineNumber - 1] ?? "" });
    }
  }

  return lines;
}

function comparePaths(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
