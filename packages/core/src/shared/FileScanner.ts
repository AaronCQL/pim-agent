import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { FileEnumerator } from "./FileEnumerator";
import { GlobExclusions } from "./GlobExclusions";

export type FileScanOptions = {
  readonly exclude?: readonly string[];
  readonly includeDotfiles: boolean;
  readonly includeIgnored: boolean;
};

/** Absolute paths; `skippedRepos` are the ignored repository roots the scan did not enter. */
type FileScan = {
  readonly paths: readonly string[];
  readonly skippedRepos: readonly string[];
};

async function scan(
  root: string,
  pattern: string,
  options: FileScanOptions
): Promise<FileScan> {
  const absoluteRoot = resolve(root);
  const walk = await FileEnumerator.walk(absoluteRoot, {
    includeDotfiles: options.includeDotfiles,
    includeIgnored: options.includeIgnored,
  });
  const expanded = await expandDirectory(absoluteRoot, pattern);
  const matcher = new Bun.Glob(expanded);
  const excludes = GlobExclusions.compile(options.exclude);
  const reach = literalPrefix(expanded);
  return {
    paths: walk.files
      .filter(
        (path) => matcher.match(path) && !GlobExclusions.ignores(excludes, path)
      )
      .map((path) => join(absoluteRoot, path)),
    skippedRepos: walk.skippedRepos
      .filter(
        (repo) =>
          (isWithin(repo, reach) || isWithin(reach, repo)) &&
          !GlobExclusions.ignores(excludes, repo) &&
          !GlobExclusions.ignores(excludes, `${repo}/`)
      )
      .map((repo) => join(absoluteRoot, repo)),
  };
}

function literalPrefix(pattern: string): string {
  const literal: string[] = [];
  for (const segment of pattern.split("/")) {
    if (/[*?[\]{}!]/.test(segment)) {
      break;
    }
    if (segment !== "" && segment !== ".") {
      literal.push(segment);
    }
  }
  return literal.join("/");
}

function isWithin(path: string, dir: string): boolean {
  return dir === "" || path === dir || path.startsWith(`${dir}/`);
}

async function expandDirectory(
  absoluteRoot: string,
  pattern: string
): Promise<string> {
  const trimmed = pattern.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");

  if (trimmed.length === 0) {
    return "**/*";
  }

  try {
    const metadata = await stat(resolve(absoluteRoot, trimmed));
    return metadata.isDirectory() ? `${trimmed}/**/*` : pattern;
  } catch {
    return pattern;
  }
}

export const FileScanner = { scan };
