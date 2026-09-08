import { readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { FsErrors } from "./FsErrors";
import { Paths } from "./Paths";

export type DirectoryEntry = {
  readonly name: string;
  readonly path: string;
};

export type DirectoryListing = {
  /** What was read: absolute, resolved, and with `~` expanded. */
  readonly path: string;
  /** Absent at the root of the filesystem, which is its own parent. */
  readonly parent?: string;
  /** The directories inside it, name-sorted, hidden ones included. */
  readonly entries: readonly DirectoryEntry[];
};

async function check(path: string): Promise<string | undefined> {
  try {
    const found = await stat(path);
    return found.isDirectory() ? undefined : `not a directory: ${path}`;
  } catch (err) {
    return FsErrors.code(err) === "ENOENT"
      ? `path does not exist: ${path}`
      : `stat failed: ${(err as Error).message}`;
  }
}

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
