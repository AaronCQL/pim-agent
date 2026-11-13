import { FileScanner, type FileScanOptions } from "../../shared/FileScanner";
import { FsErrors } from "../../shared/FsErrors";

export type GlobMatch = {
  readonly path: string;
  readonly mtime: number;
};

type GlobResult = {
  readonly matches: readonly GlobMatch[];
  readonly skippedRepos: readonly string[];
};

export async function findFiles(
  root: string,
  pattern: string,
  options: FileScanOptions
): Promise<GlobResult> {
  const metadata = await FsErrors.statOrThrow(root);

  if (!metadata.isDirectory()) {
    throw new Error(
      `Glob path must be a directory: ${root}. Drop "path" and put the filename in "pattern", or use the read tool to inspect a single file.`
    );
  }

  const { paths, skippedRepos } = await FileScanner.scan(
    root,
    pattern,
    options
  );
  const matches: GlobMatch[] = paths.map((path) => ({
    path,
    mtime: Bun.file(path).lastModified,
  }));
  matches.sort(
    (left, right) =>
      right.mtime - left.mtime || left.path.localeCompare(right.path)
  );

  return { matches, skippedRepos };
}
