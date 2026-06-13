import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { GitignoreFilter } from "../../shared/GitignoreFilter";
import { Paths } from "../../shared/Paths";

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
  readonly limit?: number;
  readonly gitSpawner?: GitSpawner;
};

export type LoadAbsoluteOptions = {
  readonly query: string;
};

const DEFAULT_LIMIT = 10_000;

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
  const filtered = entries.filter((entry) => {
    if (!includeDot && entry.name.startsWith(".")) {
      return false;
    }
    return true;
  });

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
  const limit = options.limit ?? DEFAULT_LIMIT;
  const spawner = options.gitSpawner ?? defaultGitSpawner;

  const fastPath = await tryGitListFiles(root, spawner);
  if (fastPath !== undefined) {
    return finalizeRelative(fastPath, limit);
  }

  const fallback = await scanWithGlob(root);
  return finalizeRelative(fallback, limit);
}

async function tryGitListFiles(
  root: string,
  spawner: GitSpawner
): Promise<readonly string[] | undefined> {
  const result = await spawner(
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: root }
  );

  if (result.exitCode !== 0) {
    return undefined;
  }

  return result.stdout.split("\n").filter((line) => line.length > 0);
}

async function scanWithGlob(root: string): Promise<readonly string[]> {
  const filter = await GitignoreFilter.for(root);
  const glob = new Bun.Glob("**/*");
  const matches: string[] = [];

  for await (const absolutePath of glob.scan({
    cwd: root,
    absolute: true,
    onlyFiles: true,
    dot: false,
  })) {
    if (!filter.ignores(absolutePath)) {
      matches.push(Paths.toForwardSlashes(relative(root, absolutePath)));
    }
  }

  return matches;
}

function finalizeRelative(
  paths: readonly string[],
  limit: number
): readonly FileCandidate[] {
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
  candidates.sort((a, b) => a.insertPath.localeCompare(b.insertPath));

  return candidates.length > limit ? candidates.slice(0, limit) : candidates;
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
