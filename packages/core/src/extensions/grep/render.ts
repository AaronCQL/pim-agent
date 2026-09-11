import { Format } from "../../shared/Format";
import { OutputBudget } from "../../shared/OutputBudget";
import { Paths } from "../../shared/Paths";
import {
  NO_MATCHES,
  type SearchList,
  SearchRender,
} from "../../shared/SearchRender";
import type { ToolView, ViewBlock } from "../../view/ViewBlock";
import type { GrepLineRange, GrepMatch } from "./grep";
import type { GrepInput, GrepOutputMode, GrepPathFormat } from "./schema";

export type RenderOutcome = SearchList & {
  readonly fileCount: number;
  readonly totalMatches: number;
  readonly itemNoun: string;
};

export type RenderOptions = {
  readonly cwd: string;
  readonly pathFormat: GrepPathFormat;
  readonly context: number;
};

const renderers: Record<
  GrepOutputMode,
  {
    readonly itemNoun: string;
    readonly toLines: (
      matches: readonly GrepMatch[],
      options: RenderOptions
    ) => readonly string[];
  }
> = {
  files_with_matches: { itemNoun: "files", toLines: renderFiles },
  content: { itemNoun: "lines", toLines: renderContent },
  count: { itemNoun: "files", toLines: renderCounts },
};

export function renderMatches(
  matches: readonly GrepMatch[],
  outputMode: GrepOutputMode,
  headLimit: number,
  options: RenderOptions
): RenderOutcome {
  const totalMatches = matches.reduce(
    (sum, match) => sum + matchCount(match),
    0
  );
  const { itemNoun, toLines } = renderers[outputMode];
  const lines = toLines(matches, options);
  const list = SearchRender.capList(lines, headLimit);
  const empty = list.totalItems === 0;

  return {
    ...list,
    fileCount: empty ? 0 : matches.length,
    totalMatches: empty ? 0 : totalMatches,
    itemNoun,
  };
}

export type TitleOptions = {
  readonly pattern: string | undefined;
  readonly path: string | undefined;
  readonly glob: string | undefined;
  readonly cwd: string;
};

export function formatTitle(options: TitleOptions): string {
  return SearchRender.subjectTitle({
    subject: formatPattern(options.pattern),
    path: options.path,
    suffix: options.glob,
    cwd: options.cwd,
  });
}

export type GrepViewDetails = {
  readonly outputMode?: GrepOutputMode;
  readonly fileCount?: number;
};

export type GrepViewInput = {
  /** Partially streamed while the call is in flight; every field is optional. */
  readonly args: Partial<GrepInput>;
  /** The result body the tool already rendered for the model; empty in flight. */
  readonly body: string;
  readonly details?: GrepViewDetails;
  readonly cwd: string;
};

export function buildView({
  args,
  body,
  details,
  cwd,
}: GrepViewInput): ToolView {
  const fileCount = details?.fileCount;
  return {
    label: "Grep",
    icon: "search",
    title: [
      {
        kind: "text",
        text: formatTitle({
          pattern: args.pattern,
          path: args.path,
          glob: args.glob,
          cwd,
        }),
      },
      ...(fileCount === undefined
        ? []
        : ([
            {
              kind: "text",
              tone: "muted",
              text: Format.count(fileCount, "file"),
            },
          ] as const)),
    ],
    body: bodyBlocks(body, details?.outputMode),
  };
}

function bodyBlocks(
  body: string,
  outputMode: GrepOutputMode | undefined
): readonly ViewBlock[] {
  if (
    outputMode === "files_with_matches" &&
    body !== "" &&
    body !== NO_MATCHES
  ) {
    return body.split("\n").map((path) => ({ kind: "file", path }) as const);
  }
  return [{ kind: "text", text: body }];
}

function formatPattern(pattern: string | undefined): string {
  return pattern === undefined ? "..." : `/${pattern}/`;
}

function renderFiles(
  matches: readonly GrepMatch[],
  options: RenderOptions
): readonly string[] {
  return byRecency(matches).map((match) =>
    SearchRender.formatPath(match.filePath, options)
  );
}

function renderContent(
  matches: readonly GrepMatch[],
  options: RenderOptions
): readonly string[] {
  if (options.context > 0) {
    return byRecency(matches).flatMap((match) =>
      renderContextContent(match, options)
    );
  }

  return byRecency(matches).flatMap((match) =>
    match.lines.map(
      (line) =>
        `${SearchRender.formatPath(match.filePath, options)}:${line.lineNumber}:${OutputBudget.truncateLine(line.text)}`
    )
  );
}

function renderContextContent(
  match: GrepMatch,
  options: RenderOptions
): readonly string[] {
  const path = SearchRender.formatPath(match.filePath, options);
  const blocks = contextBlocks(
    match.ranges,
    match.fileLines.length,
    options.context
  );
  const lines: string[] = [];

  for (const [blockIndex, block] of blocks.entries()) {
    if (blockIndex > 0) {
      lines.push("--");
    }

    for (
      let lineNumber = block.startLineNumber;
      lineNumber <= block.endLineNumber;
      lineNumber += 1
    ) {
      const marker = isMatchLine(match.ranges, lineNumber) ? ">" : " ";
      const text = OutputBudget.truncateLine(
        match.fileLines[lineNumber - 1] ?? ""
      );
      lines.push(`${marker} ${path}:${lineNumber}:${text}`);
    }
  }

  return lines;
}

function renderCounts(
  matches: readonly GrepMatch[],
  options: RenderOptions
): readonly string[] {
  return [...matches]
    .sort(
      (left, right) =>
        matchCount(right) - matchCount(left) ||
        right.mtime - left.mtime ||
        Paths.compare(left.filePath, right.filePath)
    )
    .map(
      (match) =>
        `${SearchRender.formatPath(match.filePath, options)}:${matchCount(match)}`
    );
}

function contextBlocks(
  ranges: readonly GrepLineRange[],
  lineCount: number,
  context: number
): readonly GrepLineRange[] {
  const blocks: GrepLineRange[] = [];

  for (const range of ranges) {
    const expanded = {
      startLineNumber: Math.max(1, range.startLineNumber - context),
      endLineNumber: Math.min(lineCount, range.endLineNumber + context),
    };
    const previous = blocks.at(-1);

    if (
      previous !== undefined &&
      expanded.startLineNumber <= previous.endLineNumber + 1
    ) {
      blocks[blocks.length - 1] = {
        startLineNumber: previous.startLineNumber,
        endLineNumber: Math.max(previous.endLineNumber, expanded.endLineNumber),
      };
    } else {
      blocks.push(expanded);
    }
  }

  return blocks;
}

function matchCount(match: GrepMatch): number {
  return match.ranges.length;
}

function isMatchLine(
  ranges: readonly GrepLineRange[],
  lineNumber: number
): boolean {
  return ranges.some(
    (range) =>
      lineNumber >= range.startLineNumber && lineNumber <= range.endLineNumber
  );
}

function byRecency(matches: readonly GrepMatch[]): readonly GrepMatch[] {
  return [...matches].sort(
    (left, right) =>
      right.mtime - left.mtime || Paths.compare(left.filePath, right.filePath)
  );
}
