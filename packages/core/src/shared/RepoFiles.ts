import { realpath, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";

import {
  type EnumerateOptions,
  FileEnumerator,
  type WalkDir,
} from "./FileEnumerator";
import { Lines } from "./Lines";
import { Paths } from "./Paths";
import { Pool } from "./Pool";

export type FolderEntry = {
  /** Several segments when single-child folders are folded together, e.g. "web/src". */
  readonly name: string;
  /** Root-relative; for a folded folder, the deepest folder's path. */
  readonly path: string;
  readonly kind: "folder" | "file";
};

export type FolderListing = {
  readonly path: string;
  readonly entries: readonly FolderEntry[];
  /** More entries exist than were returned. */
  readonly truncated?: boolean;
};

export type FoundFiles = {
  readonly paths: readonly string[];
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

const FOLDER_LIMIT = 5_000;

const FOLD_CONCURRENCY = 32;

const FIND_WALK_LIMIT = 200_000;

const MATCH_LIMIT = 200;

const VISIBLE: EnumerateOptions = {
  includeDotfiles: true,
  includeNestedRepos: true,
};

const READ_BYTE_LIMIT = 1_000_000;

/** The real path of `path`, strictly inside `cwd`; resolves symlinks too, so a link can't lead out of it. */
async function locate(cwd: string, path: string): Promise<string> {
  return locateUnder(await realpath(cwd), path);
}

async function locateUnder(root: string, path: string): Promise<string> {
  const target = await realpath(resolve(root, path)).catch(() => {
    throw new Error(`${path} does not exist`);
  });
  if (target === root || !Paths.within(root, target)) {
    throw new Error(`${path} is outside the working directory`);
  }
  return target;
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function byName(
  left: { readonly name: string },
  right: { readonly name: string }
): number {
  return Paths.compare(left.name.toLowerCase(), right.name.toLowerCase());
}

async function fold(dir: WalkDir): Promise<FolderEntry> {
  let name = nameOf(dir.rel);
  let deepest = dir;
  for (;;) {
    const { dirs, files } = await FileEnumerator.children(deepest);
    const [only] = dirs;
    if (only === undefined || dirs.length > 1 || files.length > 0) {
      return { name, path: deepest.rel, kind: "folder" };
    }
    name = `${name}/${nameOf(only.rel)}`;
    deepest = only;
  }
}

/** One folder's visible entries, folders first; a folder holding one folder and nothing else folds into it. */
async function folder(cwd: string, path: string): Promise<FolderListing> {
  const root = await realpath(cwd);
  let rel = "";
  if (path !== "") {
    const target = await locateUnder(root, path);
    if (!(await stat(target)).isDirectory()) {
      throw new Error(`${path} is not a folder`);
    }
    rel = Paths.toForwardSlashes(relative(root, target));
  }
  const dir = await FileEnumerator.folder(root, rel, VISIBLE);
  if (dir === undefined) {
    throw new Error(`${path} is ignored`);
  }
  const { dirs, files } = await FileEnumerator.children(dir);
  const kept = dirs
    .map((child) => ({ name: nameOf(child.rel), child }))
    .toSorted(byName)
    .slice(0, FOLDER_LIMIT);
  const folders = await Pool.mapPooled(kept, FOLD_CONCURRENCY, ({ child }) =>
    fold(child)
  );
  const entries = [
    ...folders.toSorted(byName),
    ...files
      .map((file): FolderEntry => ({
        name: nameOf(file),
        path: file,
        kind: "file",
      }))
      .toSorted(byName),
  ];
  return entries.length > FOLDER_LIMIT
    ? { path: rel, entries: entries.slice(0, FOLDER_LIMIT), truncated: true }
    : { path: rel, entries };
}

function words(query: string): readonly string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Paths holding every word of `query`; ones whose name holds it come first. */
function match(paths: readonly string[], query: string): readonly string[] {
  const wanted = words(query);
  const named: string[] = [];
  const nested: string[] = [];
  if (wanted.length === 0) {
    return named;
  }
  for (const path of paths) {
    const lower = path.toLowerCase();
    if (!wanted.every((word) => lower.includes(word))) {
      continue;
    }
    const name = nameOf(lower);
    if (wanted.some((word) => name.includes(word))) {
      named.push(path);
    } else if (nested.length < MATCH_LIMIT) {
      nested.push(path);
    }
    if (named.length >= MATCH_LIMIT) {
      break;
    }
  }
  return [...named, ...nested.slice(0, MATCH_LIMIT - named.length)];
}

/** Files under `cwd` matching `query`, from the same files `folder` shows. */
async function find(cwd: string, query: string): Promise<FoundFiles> {
  if (words(query).length === 0) {
    return { paths: [] };
  }
  const { files } = await FileEnumerator.walk(await realpath(cwd), {
    ...VISIBLE,
    limit: FIND_WALK_LIMIT,
  });
  return { paths: match(files.toSorted(), query) };
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
  folder,
  find,
  match,
  read,
  locate,
  FOLDER_LIMIT,
  MATCH_LIMIT,
  READ_BYTE_LIMIT,
};
