import { lstat, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import { FileEnumerator } from "../shared/FileEnumerator";
import { NestedRepos } from "../shared/NestedRepos";
import { Paths } from "../shared/Paths";
import { Pool } from "../shared/Pool";

export type FileCandidate = {
  readonly insertPath: string;
  readonly displayPath: string;
  readonly matchHaystack: string;
  readonly isDirectory: boolean;
};

export type AbsoluteCatalog = {
  readonly candidates: readonly FileCandidate[];
  readonly residualQuery: string;
};

export type GitSpawnResult = {
  readonly exitCode: number;
  readonly stdout: string;
};

export type GitSpawner = (
  args: readonly string[],
  options: { readonly cwd: string }
) => Promise<GitSpawnResult>;

export type LoadRelativeOptions = {
  readonly root: string;
  readonly gitSpawner?: GitSpawner;
};

export type LoadAbsoluteOptions = {
  readonly query: string;
};

const defaultGitSpawner: GitSpawner = async (args, options) => {
  try {
    const child = Bun.spawn(["git", ...args], {
      cwd: options.cwd,
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    const stdout = await new Response(child.stdout).text();
    const exitCode = await child.exited;
    return { exitCode, stdout };
  } catch {
    return { exitCode: -1, stdout: "" };
  }
};

const inflightRelative = new Map<string, Promise<readonly FileCandidate[]>>();
const COLLATOR = new Intl.Collator(undefined);

export function loadRelative(
  options: LoadRelativeOptions
): Promise<readonly FileCandidate[]> {
  const root = resolve(options.root);
  const existing = inflightRelative.get(root);
  if (existing !== undefined) {
    return existing;
  }

  const promise = runLoadRelative(root, options).finally(() => {
    inflightRelative.delete(root);
  });
  inflightRelative.set(root, promise);
  return promise;
}

export async function loadAbsolute(
  options: LoadAbsoluteOptions
): Promise<AbsoluteCatalog> {
  const expanded = Paths.expandHome(options.query);
  const normalized = isAbsolute(expanded) ? resolve(expanded) : expanded;
  const anchor = await findAnchor(normalized);
  const residualSlice = normalized.slice(anchor.length);
  const residualQuery =
    residualSlice.startsWith(sep) || residualSlice.startsWith("/")
      ? residualSlice.slice(1)
      : residualSlice;

  let entries: { readonly name: string; readonly isDirectory: boolean }[];
  try {
    const dirents = await readdir(anchor, { withFileTypes: true });
    entries = dirents.map((dirent) => ({
      name: dirent.name,
      isDirectory: dirent.isDirectory(),
    }));
  } catch {
    return { candidates: [], residualQuery };
  }

  const includeDot = residualQuery.startsWith(".");
  const filtered = includeDot
    ? entries
    : entries.filter((entry) => !entry.name.startsWith("."));

  filtered.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  const candidates: FileCandidate[] = filtered.map((entry) => {
    const fullPath = join(anchor, entry.name);
    return {
      insertPath: fullPath,
      displayPath: fullPath,
      matchHaystack: entry.name,
      isDirectory: entry.isDirectory,
    };
  });

  return { candidates, residualQuery };
}

async function runLoadRelative(
  root: string,
  options: LoadRelativeOptions
): Promise<readonly FileCandidate[]> {
  const spawner = options.gitSpawner ?? defaultGitSpawner;
  const paths =
    (await listTree(root, 0, { remaining: NestedRepos.LIMIT }, spawner)) ??
    (await FileEnumerator.enumerate(root, {
      includeDotfiles: false,
      includeIgnored: false,
    }));
  return finalizeRelative(paths);
}

type RepoListing = {
  readonly files: readonly string[];
  readonly nestedRepos: readonly string[];
};

const NESTED_REPO_DEPTH = 4;
const NESTED_REPO_CONCURRENCY = 8;
const GITLINK_MODE = "160000";
const STAGED_RECORD = /^(\d{6}) [0-9a-f]+ \d\t(.*)$/s;

async function listTree(
  dir: string,
  depth: number,
  budget: { remaining: number },
  spawner: GitSpawner
): Promise<readonly string[] | undefined> {
  const listing = await listRepo(
    dir,
    spawner,
    depth < NESTED_REPO_DEPTH && budget.remaining > 0
  );
  if (listing === undefined) {
    return undefined;
  }
  const nestedRepos = listing.nestedRepos.slice(0, budget.remaining);
  if (nestedRepos.length === 0) {
    return listing.files;
  }
  budget.remaining -= nestedRepos.length;
  const expanded = await Pool.mapPooled(
    nestedRepos,
    NESTED_REPO_CONCURRENCY,
    async (nested) => {
      const files =
        (await listTree(join(dir, nested), depth + 1, budget, spawner)) ?? [];
      return files.map((file) => `${nested}/${file}`);
    }
  );
  return [...listing.files, ...expanded.flat()];
}

async function listRepo(
  dir: string,
  spawner: GitSpawner,
  wantNested: boolean
): Promise<RepoListing | undefined> {
  const [listed, ignored] = await Promise.all([
    spawner(["ls-files", "-z", "--stage", "--others", "--exclude-standard"], {
      cwd: dir,
    }),
    wantNested
      ? spawner(
          [
            "ls-files",
            "-z",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
          ],
          { cwd: dir }
        )
      : undefined,
  ]);
  if (listed.exitCode !== 0) {
    return undefined;
  }

  const files = new Set<string>();
  const candidates = new Set<string>();
  for (const record of nulRecords(listed.stdout)) {
    const staged = STAGED_RECORD.exec(record);
    if (staged === null) {
      if (record.endsWith("/")) {
        candidates.add(record.slice(0, -1));
      } else {
        files.add(record);
      }
    } else if (staged[1] === GITLINK_MODE) {
      candidates.add(staged[2]!);
    } else {
      files.add(staged[2]!);
    }
  }
  if (!wantNested) {
    return { files: [...files], nestedRepos: [] };
  }
  if (ignored?.exitCode === 0) {
    for (const record of nulRecords(ignored.stdout)) {
      if (record.endsWith("/")) {
        candidates.add(record.slice(0, -1));
      }
    }
  }

  const repoRoots = await Promise.all(
    [...candidates].map(async (candidate) =>
      (await isNestedRepo(join(dir, candidate))) ? [candidate] : []
    )
  );
  return { files: [...files], nestedRepos: repoRoots.flat().sort() };
}

async function isNestedRepo(dir: string): Promise<boolean> {
  const metadata = await lstat(dir).catch(() => undefined);
  return (
    metadata?.isDirectory() === true && (await FileEnumerator.isNestedRepo(dir))
  );
}

function nulRecords(stdout: string): readonly string[] {
  return stdout.split("\0").filter((record) => record.length > 0);
}

function finalizeRelative(paths: readonly string[]): readonly FileCandidate[] {
  const normalized = paths.map(Paths.toForwardSlashes);

  // git ls-files only emits files; recover directories from their prefixes.
  const directories = new Set<string>();
  for (const path of normalized) {
    for (
      let slash = path.indexOf("/");
      slash !== -1;
      slash = path.indexOf("/", slash + 1)
    ) {
      directories.add(path.slice(0, slash));
    }
  }

  const candidates = [
    ...[...directories].map((path) => toRelativeCandidate(path, true)),
    ...normalized.map((path) => toRelativeCandidate(path, false)),
  ];
  candidates.sort((a, b) => COLLATOR.compare(a.insertPath, b.insertPath));

  return candidates;
}

function toRelativeCandidate(
  path: string,
  isDirectory: boolean
): FileCandidate {
  return {
    insertPath: path,
    displayPath: path,
    matchHaystack: path,
    isDirectory,
  };
}

async function findAnchor(absolutePath: string): Promise<string> {
  if (!isAbsolute(absolutePath)) {
    return parse(process.cwd()).root;
  }

  const filesystemRoot = parse(absolutePath).root;
  let current = absolutePath;

  while (true) {
    try {
      const metadata = await stat(current);
      if (metadata.isDirectory()) {
        return current;
      }
    } catch {}

    if (current === filesystemRoot) {
      return filesystemRoot;
    }

    const parent = resolve(current, "..");
    if (parent === current) {
      return filesystemRoot;
    }
    current = parent;
  }
}
