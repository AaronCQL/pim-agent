import { join, resolve } from "node:path";
import { FileEnumerator } from "./FileEnumerator";
import { GlobExclusions } from "./GlobExclusions";

export type FileScanOptions = {
  readonly exclude?: readonly string[];
  readonly includeDotfiles: boolean;
  readonly includeIgnored: boolean;
};

export class FileScanner {
  static async scan(
    root: string,
    pattern: string,
    options: FileScanOptions
  ): Promise<readonly string[]> {
    const absoluteRoot = resolve(root);
    const relativePaths = await FileEnumerator.enumerate(absoluteRoot, {
      includeDotfiles: options.includeDotfiles,
      includeIgnored: options.includeIgnored,
    });
    const matcher = new Bun.Glob(pattern);
    const excludes = GlobExclusions.compile(options.exclude);
    const files: string[] = [];

    for (const relativePath of relativePaths) {
      if (!matcher.match(relativePath)) {
        continue;
      }
      const absolutePath = join(absoluteRoot, relativePath);
      if (GlobExclusions.ignores(excludes, absoluteRoot, absolutePath)) {
        continue;
      }
      files.push(absolutePath);
    }

    return files;
  }
}
