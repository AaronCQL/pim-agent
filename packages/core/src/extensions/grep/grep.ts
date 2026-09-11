import { FileScanner, type FileScanOptions } from "../../shared/FileScanner";
import { FsErrors } from "../../shared/FsErrors";
import { Lines } from "../../shared/Lines";
import { Paths } from "../../shared/Paths";
import { Pool } from "../../shared/Pool";

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
  /** Raw-byte needle for the literal fast path; undefined leaves the regex path unchanged. */
  readonly literal: Buffer | undefined;
};

export type GrepScanOptions = FileScanOptions & {
  readonly retainFileLines?: boolean;
};

// ASCII-only: these stand for themselves in both a default-flag regex and raw UTF-8 bytes.
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
        Paths.compare
      );
  const scanned = await Pool.mapPooled(files, MATCH_CONCURRENCY, (filePath) =>
    matchFile(filePath, matcher, options.retainFileLines ?? true)
  );

  return scanned.filter((match) => match !== undefined);
}

// An entry may not be a readable regular file: an unreadable one is a non-match, never a failure.
async function matchFile(
  filePath: string,
  matcher: GrepMatcher,
  retainFileLines: boolean
): Promise<GrepMatch | undefined> {
  const file = Bun.file(filePath);

  let text: string;
  try {
    if (await Lines.isBinary(file)) {
      return undefined;
    }

    if (matcher.literal !== undefined) {
      // Literal fast path: an ASCII needle's raw-byte hit/miss matches the decoded result.
      const bytes = Buffer.from(await file.arrayBuffer());
      if (bytes.indexOf(matcher.literal) < 0) {
        return undefined;
      }
      text = bytes.toString("utf8");
    } else {
      text = await file.text();
    }
  } catch {
    return undefined;
  }

  const content = Lines.normalize(text);
  const fileLines = Lines.splitNormalized(content);
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
    fileLines: retainFileLines ? fileLines : [],
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
  const cursor: LineCursor = { offset: 0, line: 1 };

  while (true) {
    const match = globalRegex.exec(content);

    if (match === null) {
      break;
    }

    ranges.push(
      lineRangeForOffsets(
        content,
        match.index,
        match.index + match[0].length,
        cursor
      )
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

type LineCursor = {
  offset: number;
  line: number;
};

function lineRangeForOffsets(
  content: string,
  startOffset: number,
  endOffset: number,
  cursor: LineCursor
): GrepLineRange {
  return {
    startLineNumber: lineNumberForOffset(content, startOffset, cursor),
    endLineNumber: lineNumberForOffset(
      content,
      Math.max(startOffset, endOffset - 1),
      cursor
    ),
  };
}

function lineNumberForOffset(
  content: string,
  offset: number,
  cursor: LineCursor
): number {
  const target = Math.min(offset, content.length);

  for (let index = cursor.offset; index < target; index += 1) {
    if (content[index] === "\n") {
      cursor.line += 1;
    }
  }

  cursor.offset = target;

  return cursor.line;
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
