import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve } from "node:path";
import ignore, { type Ignore } from "ignore";
import { FsErrors } from "./FsErrors";
import { Paths } from "./Paths";

type IgnoreMatcher = {
  readonly baseDirectory: string;
  readonly matcher: Ignore;
};

export class GitignoreFilter {
  private static readonly alwaysIgnoredPatterns = [
    ".git/",
    "node_modules/",
    "dist/",
    "build/",
    "out/",
    "target/",
    "coverage/",
    ".next/",
    ".cache/",
    ".turbo/",
    ".vercel/",
    ".svelte-kit/",
  ] as const;

  private readonly matchers: readonly IgnoreMatcher[];

  private constructor(matchers: readonly IgnoreMatcher[]) {
    this.matchers = matchers;
  }

  public static async for(root: string): Promise<GitignoreFilter> {
    const absoluteRoot = resolve(root);
    const rootDirectory =
      await GitignoreFilter.containingDirectory(absoluteRoot);
    const directories =
      await GitignoreFilter.gitignoreDirectories(rootDirectory);
    const contents = await Promise.all(
      directories.map((directory) => GitignoreFilter.readGitignore(directory))
    );
    const matchers: IgnoreMatcher[] = [
      {
        baseDirectory: rootDirectory,
        matcher: ignore().add([...GitignoreFilter.alwaysIgnoredPatterns]),
      },
    ];

    for (const [index, directory] of directories.entries()) {
      const body = contents[index];

      if (body !== undefined) {
        matchers.push({
          baseDirectory: directory,
          matcher: ignore().add(body),
        });
      }
    }

    return new GitignoreFilter(matchers);
  }

  public ignores(absolutePath: string): boolean {
    if (!isAbsolute(absolutePath)) {
      throw new Error(`Expected absolute path: ${absolutePath}`);
    }

    for (const { baseDirectory, matcher } of this.matchers) {
      const candidate = this.relativePath(baseDirectory, absolutePath);

      if (candidate !== undefined && matcher.ignores(candidate)) {
        return true;
      }
    }

    return false;
  }

  private static async containingDirectory(path: string): Promise<string> {
    const metadata = await stat(path);

    return metadata.isDirectory() ? path : dirname(path);
  }

  private static async gitignoreDirectories(
    root: string
  ): Promise<readonly string[]> {
    const directories: string[] = [];
    const filesystemRoot = parse(root).root;
    let current = root;

    while (true) {
      directories.push(current);

      if (await Bun.file(resolve(current, ".git")).exists()) {
        break;
      }

      if (current === filesystemRoot) {
        break;
      }

      current = dirname(current);
    }

    return directories;
  }

  private static async readGitignore(
    directory: string
  ): Promise<string | undefined> {
    const path = resolve(directory, ".gitignore");

    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (FsErrors.code(error) === "ENOENT") {
        return undefined;
      }

      throw error;
    }
  }

  private relativePath(
    baseDirectory: string,
    absolutePath: string
  ): string | undefined {
    const candidate = relative(baseDirectory, absolutePath);

    if (
      candidate.length === 0 ||
      candidate.startsWith("..") ||
      isAbsolute(candidate)
    ) {
      return undefined;
    }

    return Paths.toForwardSlashes(candidate);
  }
}
