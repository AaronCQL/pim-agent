import { FileScanner, type FileScanOptions } from "../../shared/FileScanner";
import { FsErrors } from "../../shared/FsErrors";

export type GlobMatch = {
  readonly path: string;
  readonly mtime: number;
};

export type GlobScanOptions = FileScanOptions;

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

  const paths = await FileScanner.scan(root, pattern, options);
  const matches: GlobMatch[] = paths.map((path) => ({
    path,
    mtime: Bun.file(path).lastModified,
  }));

  return matches.sort(
    (left, right) =>
      right.mtime - left.mtime || left.path.localeCompare(right.path)
  );
}
