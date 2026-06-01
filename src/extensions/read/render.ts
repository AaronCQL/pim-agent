import type { Theme } from "@earendil-works/pi-coding-agent";
import { Paths } from "../../shared/Paths";

export type ReadTitleOutcome = {
  readonly visibleStart: number;
  readonly visibleEnd: number;
};

export type TitlePathOptions = {
  readonly path: string | undefined;
  readonly cwd: string;
  readonly start: number | undefined;
  readonly end: number | undefined;
  readonly outcome?: ReadTitleOutcome;
};

export function formatTitlePath(options: TitlePathOptions): string {
  const { path, range } = formatTitlePathParts(options);
  return `${path}${range}`;
}

export function renderTitlePath(
  options: TitlePathOptions,
  theme: Theme
): string {
  const { path, range } = formatTitlePathParts(options);
  return `${path}${range === "" ? "" : theme.fg("muted", range)}`;
}

function formatTitlePathParts(options: TitlePathOptions): {
  readonly path: string;
  readonly range: string;
} {
  const path = options.path
    ? Paths.displayRelative(options.path, options.cwd)
    : "...";
  const range = formatRange(options.start, options.end, options.outcome);
  return { path, range };
}

function formatRange(
  start: number | undefined,
  end: number | undefined,
  outcome: ReadTitleOutcome | undefined
): string {
  if (outcome !== undefined) {
    return `:${outcome.visibleStart}-${outcome.visibleEnd}`;
  }

  if (start === undefined && end === undefined) {
    return "";
  }

  const startLine = start ?? 1;

  if (end === undefined) {
    return `:${startLine}`;
  }

  return `:${startLine}-${end}`;
}
