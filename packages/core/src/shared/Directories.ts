import { mkdir, readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

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

function rooted(path: string): string {
  const expanded = Paths.expandHome(path);
  if (!isAbsolute(expanded)) {
    throw new Error(`not an absolute path: ${path}`);
  }
  return resolve(expanded);
}

async function list(path: string): Promise<DirectoryListing> {
  const resolved = rooted(path);
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

function refusal(error: unknown, path: string): string {
  switch (FsErrors.code(error)) {
    case "ENOENT":
      return `path does not exist: ${dirname(path)}`;
    case "EEXIST":
      return `already exists: ${path}`;
    case "ENOTDIR":
      return `not a directory: ${dirname(path)}`;
    case "EACCES":
    case "EPERM":
      return `permission denied: ${path}`;
    default:
      return `mkdir failed: ${(error as Error).message}`;
  }
}

/** Makes one directory inside an existing one. Never recursive: a parent that is missing is said so, not invented. */
async function create(path: string): Promise<void> {
  const name = basename(Paths.expandHome(path));
  if (name === "" || name === "." || name === "..") {
    throw new Error(`not a directory to create: ${path}`);
  }
  const resolved = rooted(path);
  try {
    await mkdir(resolved);
  } catch (error) {
    throw new Error(refusal(error, resolved));
  }
}

export const Directories = { check, list, create };
