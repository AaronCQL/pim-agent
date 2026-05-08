import { Paths } from "../../shared/Paths";

export type TitlePathOptions = {
  readonly path: string | undefined;
  readonly cwd: string;
  readonly start: number | undefined;
  readonly end: number | undefined;
};

export function formatTitlePath(options: TitlePathOptions): string {
  const path = options.path
    ? Paths.displayRelative(options.path, options.cwd)
    : "...";
  const range = formatRange(options.start, options.end);
  return `${path}${range}`;
}

function formatRange(
  start: number | undefined,
  end: number | undefined
): string {
  if (start === undefined && end === undefined) {
    return "";
  }

  const startLine = start ?? 1;

  if (end === undefined) {
    return `:${startLine}`;
  }

  return `:${startLine}-${end}`;
}
