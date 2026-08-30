import { stat } from "node:fs/promises";
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
    const matcher = new Bun.Glob(await expandDirectory(absoluteRoot, pattern));
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

/**
 * A bare directory (`src/telegram`) is a natural thing to reach for as a
 * pattern, but it matches nothing and silently returns zero results. Treat it
 * as `src/telegram/**\/*` instead of forcing a second, corrected call.
 */
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
