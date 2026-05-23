import { resolve } from "node:path";
import { FsErrors } from "../../shared/FsErrors";
import { GitignoreFilter } from "../../shared/GitignoreFilter";
import { GlobExclusions } from "../../shared/GlobExclusions";
import { Lines } from "../../shared/Lines";

const MATCH_CONCURRENCY = 32;

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
};

export type GrepScanOptions = {
  readonly exclude?: readonly string[];
  readonly includeDotfiles: boolean;
  readonly includeIgnored: boolean;
};

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
    : await scanFiles(path, glob ?? "**/*", options);
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

  if (await Lines.isBinary(file)) {
    return undefined;
  }

  const content = Lines.normalize(await file.text());
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

async function scanFiles(
  path: string,
  pattern: string,
  options: GrepScanOptions
): Promise<readonly string[]> {
  const root = resolve(path);
  const filter = options.includeIgnored
    ? undefined
    : await GitignoreFilter.for(root);
  const excludes = GlobExclusions.compile(options.exclude);
  const glob = new Bun.Glob(pattern);
  const files: string[] = [];

  for await (const filePath of glob.scan({
    cwd: root,
    absolute: true,
    onlyFiles: true,
    dot: options.includeDotfiles,
  })) {
    if (
      (filter === undefined || !filter.ignores(filePath)) &&
      !GlobExclusions.ignores(excludes, root, filePath)
    ) {
      files.push(filePath);
    }
  }

  return files.sort(comparePaths);
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
