import { OutputBudget } from "./OutputBudget";
import { Paths } from "./Paths";

export const NO_MATCHES = "No matches.";

export type SearchPathFormat = "relative" | "absolute";

export type SearchPathOptions = {
  readonly cwd: string;
  readonly pathFormat: SearchPathFormat;
};

export type SearchList = {
  readonly body: string;
  readonly totalItems: number;
  readonly visibleItems: number;
  readonly truncated: boolean;
};

export type SubjectTitleOptions = {
  readonly subject: string;
  readonly path: string | undefined;
  readonly suffix?: string | undefined;
  readonly cwd: string;
};

function formatPath(path: string, options: SearchPathOptions): string {
  return options.pathFormat === "absolute"
    ? path
    : Paths.displayRelative(path, options.cwd);
}

function subjectTitle(options: SubjectTitleOptions): string {
  const resolved =
    options.path === undefined
      ? undefined
      : Paths.resolve(options.path, options.cwd);
  const dir =
    resolved === undefined || resolved === options.cwd
      ? undefined
      : Paths.displayRelative(resolved, options.cwd);
  const target = joinTarget(dir, options.suffix);
  const location = target ? ` in ${target}` : "";
  return `${options.subject}${location}`;
}

function joinTarget(
  dir: string | undefined,
  suffix: string | undefined
): string | undefined {
  if (suffix === undefined) {
    return dir;
  }
  return dir === undefined ? suffix : `${dir}/${suffix}`;
}

function capList(lines: readonly string[], headLimit: number): SearchList {
  if (lines.length === 0) {
    return {
      body: NO_MATCHES,
      totalItems: 0,
      visibleItems: 0,
      truncated: false,
    };
  }

  const { visible } = OutputBudget.applyByteCap(lines.slice(0, headLimit));

  return {
    body: visible.join("\n"),
    totalItems: lines.length,
    visibleItems: visible.length,
    truncated: visible.length < lines.length,
  };
}

export const SearchRender = {
  NO_MATCHES,
  formatPath,
  subjectTitle,
  capList,
};
