import type { WebFetchFormat, WebFetchResolvedFormat } from "./schema";

export type WebFetchTitleOutcome = {
  readonly format: WebFetchResolvedFormat;
  readonly totalBytes: number;
};

export function formatTitle(
  url: string | undefined,
  format: WebFetchFormat | undefined,
  outcome: WebFetchTitleOutcome | undefined
): string {
  const u = url ?? "...";
  const label = formatLabel(outcome?.format ?? format ?? "markdown");

  if (outcome !== undefined) {
    return `${u} (${formatSize(outcome.totalBytes)} ${label})`;
  }

  return `${u} (${label})`;
}

function formatLabel(format: WebFetchResolvedFormat): string {
  return format === "html" ? "HTML" : "Markdown";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${trimZeros((bytes / 1024).toFixed(2))}KB`;
  }
  return `${trimZeros((bytes / (1024 * 1024)).toFixed(2))}MB`;
}

function trimZeros(value: string): string {
  return value.replace(/\.?0+$/u, "");
}
