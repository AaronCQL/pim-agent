import { isAbsolute, relative } from "node:path";
import type { ReadFormat } from "./schema";

export type TitlePathOptions = {
  readonly path: string | undefined;
  readonly cwd: string;
  readonly start: number | undefined;
  readonly end: number | undefined;
  readonly format: ReadFormat;
};

export function formatTitlePath(options: TitlePathOptions): string {
  const path = displayPath(options.path, options.cwd);
  const range = formatRange(options.start, options.end);
  return `${path}${range} (${options.format})`;
}

function displayPath(rawPath: string | undefined, cwd: string): string {
  if (!rawPath) {
    return "...";
  }

  const rel = relative(cwd, rawPath);

  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return rawPath;
  }

  return rel;
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
