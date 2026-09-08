import { readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { Paths } from "./Paths";

/** One subdirectory, named and located, so a client does no path arithmetic. */
export type DirectoryEntry = {
  readonly name: string;
  readonly path: string;
};

export type DirectoryListing = {
  /** What was read: absolute, resolved, and with `~` expanded. */
  readonly path: string;
  /** Absent at the root of the filesystem, which is its own parent. */
  readonly parent?: string;
  /**
   * The directories inside it, name-sorted, symlinks to directories among
   * them. Hidden ones are here too: which of them are noise is a question
   * about what the reader has typed, so it is answered where the filter is
   * rather than by leaving them out of the only answer there is.
   */
  readonly entries: readonly DirectoryEntry[];
};

/**
 * Why `path` cannot be a session's working directory, or `undefined` when it
 * can. One wording for the whole distribution: the same sentence answers a
 * `set_cwd`, a new session opened somewhere, and a browse into a directory
 * that has since been deleted.
 */
async function check(path: string): Promise<string | undefined> {
  try {
    const found = await stat(path);
    return found.isDirectory() ? undefined : `not a directory: ${path}`;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? `path does not exist: ${path}`
      : `stat failed: ${(err as Error).message}`;
  }
}

/**
 * The directories inside one directory, on the filesystem the agent runs on.
 *
 * Absolute (or `~`-rooted) only. A relative path would be resolved against
 * whatever directory this process happens to have been started in, which is
 * nothing any caller means: a daemon's cwd is an accident of its unit file.
 *
 * Uncapped, because a truncated listing is a lie a filter cannot detect: a
 * client that hides what does not match would silently hide what was never
 * sent. Names are cheap even by the thousand, and a directory that large is
 * one nobody browses twice.
 */
async function list(path: string): Promise<DirectoryListing> {
  const expanded = Paths.expandHome(path);
  if (!isAbsolute(expanded)) {
    throw new Error(`not an absolute path: ${path}`);
  }
  const resolved = resolve(expanded);
  const reason = await check(resolved);
  if (reason !== undefined) {
    throw new Error(reason);
  }
  const found = await Promise.all(
    (await readdir(resolved, { withFileTypes: true })).map(async (entry) => {
      const child = join(resolved, entry.name);
      // A symlink is only followed far enough to answer whether it lands on
      // a directory; a broken one is not one, and stats no further.
      const directory = entry.isSymbolicLink()
        ? ((await stat(child).catch(() => undefined))?.isDirectory() ?? false)
        : entry.isDirectory();
      return directory ? { name: entry.name, path: child } : undefined;
    })
  );
  const parent = dirname(resolved);
  return {
    path: resolved,
    ...(parent === resolved ? {} : { parent }),
    entries: found
      .filter((entry): entry is DirectoryEntry => entry !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export const Directories = { check, list };
