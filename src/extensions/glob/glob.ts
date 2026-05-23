import { resolve } from "node:path";
import { FsErrors } from "../../shared/FsErrors";
import { GitignoreFilter } from "../../shared/GitignoreFilter";
import { GlobExclusions } from "../../shared/GlobExclusions";

export type GlobMatch = {
  readonly path: string;
  readonly mtime: number;
};

export type GlobScanOptions = {
  readonly exclude?: readonly string[];
  readonly includeDotfiles: boolean;
  readonly includeIgnored: boolean;
};

export async function findFiles(
  root: string,
  pattern: string,
  options: GlobScanOptions
): Promise<readonly GlobMatch[]> {
  const metadata = await FsErrors.statOrThrow(root);

  if (!metadata.isDirectory()) {
    throw new Error(
      `Glob path must be a directory: ${root}. Drop "path" and put the filename in "pattern", or use the read tool to inspect a single file.`
    );
  }

  const absoluteRoot = resolve(root);
  const filter = options.includeIgnored
    ? undefined
    : await GitignoreFilter.for(absoluteRoot);
  const excludes = GlobExclusions.compile(options.exclude);
  const glob = new Bun.Glob(pattern);
  const matches: GlobMatch[] = [];

  for await (const path of glob.scan({
    cwd: absoluteRoot,
    absolute: true,
    onlyFiles: true,
    dot: options.includeDotfiles,
  })) {
    if (
      (filter === undefined || !filter.ignores(path)) &&
      !GlobExclusions.ignores(excludes, absoluteRoot, path)
    ) {
      matches.push({
        path,
        mtime: Bun.file(path).lastModified,
      });
    }
  }

  return matches.sort(
    (left, right) =>
      right.mtime - left.mtime || left.path.localeCompare(right.path)
  );
}
