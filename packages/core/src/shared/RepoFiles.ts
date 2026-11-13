import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { FileEnumerator } from "./FileEnumerator";
import { Lines } from "./Lines";
import { Paths } from "./Paths";

export type FileList = {
  /** Root-relative POSIX paths, sorted. */
  readonly paths: readonly string[];
  /** More files exist than were returned. */
  readonly truncated?: boolean;
};

export type FileContent = {
  readonly path: string;
  readonly bytes: number;
  /** Changes whenever the file's content does. */
  readonly fingerprint: string;
  /** Absent for a binary file or one too large to show. */
  readonly text?: string;
  readonly binary?: boolean;
};

const LIST_LIMIT = 20_000;

const READ_BYTE_LIMIT = 1_000_000;

/** The real path of `path`, strictly inside `cwd`; resolves symlinks too, so a link can't lead out of it. */
async function locate(cwd: string, path: string): Promise<string> {
  const root = await realpath(cwd);
  const target = await realpath(resolve(root, path)).catch(() => {
    throw new Error(`${path} does not exist`);
  });
  if (target === root || !Paths.within(root, target)) {
    throw new Error(`${path} is outside the working directory`);
  }
  return target;
}

/** Every file in `cwd`: dotfiles included, skipping what git ignores but entering a nested repository even when ignored. */
async function list(cwd: string): Promise<FileList> {
  const { files } = await FileEnumerator.walk(cwd, {
    includeDotfiles: true,
    includeNestedRepos: true,
    limit: LIST_LIMIT + 1,
  });
  const sorted = files.toSorted();
  return sorted.length > LIST_LIMIT
    ? { paths: sorted.slice(0, LIST_LIMIT), truncated: true }
    : { paths: sorted };
}

/** The working-tree file; text only when it is small and not binary. */
async function read(cwd: string, path: string): Promise<FileContent> {
  const target = await locate(cwd, path);
  const info = await stat(target);
  if (!info.isFile()) {
    throw new Error(`${path} is not a file`);
  }
  const head = {
    path,
    bytes: info.size,
    fingerprint: `${info.size}:${info.mtimeMs}`,
  };
  if (info.size > READ_BYTE_LIMIT) {
    return head;
  }
  const bytes = await Bun.file(target).bytes();
  return Lines.isBinaryBytes(bytes)
    ? { ...head, binary: true }
    : { ...head, text: new TextDecoder().decode(bytes) };
}

export const RepoFiles = {
  list,
  read,
  locate,
  LIST_LIMIT,
  READ_BYTE_LIMIT,
};
