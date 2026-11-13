import { readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import ignore, { type Ignore } from "ignore";

const CONCURRENCY = 32;

export type EnumerateOptions = {
  readonly includeDotfiles?: boolean;
  readonly includeIgnored?: boolean;
  /** Enters ignored repository roots instead of skipping them; one inside an ignored plain directory is not found. */
  readonly includeNestedRepos?: boolean;
  /** Stops walking once this many files are found; a few more may still land. */
  readonly limit?: number;
};

type Policy = {
  readonly includeDotfiles: boolean;
  readonly useIgnore: boolean;
  readonly includeNestedRepos: boolean;
  readonly globalGitIgnore: string | undefined;
};

/** A folder the walk enters; only the walk reads past `rel`. */
export type WalkDir = {
  /** Root-relative POSIX path; `""` for the root. */
  readonly rel: string;
};

/** A folder the walk enters, carrying the ignore rules in force above it. */
type Dir = WalkDir & {
  readonly abs: string;
  readonly policy: Policy;
  readonly inRepo: boolean;
  readonly repoRootAbs: string;
  readonly ignoreRules: string[];
  readonly matcher: Ignore;
};

/** A folder's visible contents, in directory order. */
export type WalkChildren<D extends WalkDir = WalkDir> = {
  readonly dirs: readonly D[];
  /** Root-relative POSIX paths. */
  readonly files: readonly string[];
  /** Ignored repository roots left out. */
  readonly skippedRepos: readonly string[];
};

const EMPTY_MATCHER = ignore();

type WalkContext = {
  readonly limit: number;
  readonly stack: Dir[];
  readonly result: string[];
  readonly skippedRepos: string[];
};

/** Root-relative POSIX paths; `skippedRepos` is sorted and lies strictly below the root. */
type FileWalk = {
  readonly files: readonly string[];
  /** Ignored repository roots the walk did not enter. */
  readonly skippedRepos: readonly string[];
};

async function readIgnoreFile(path: string): Promise<string | undefined> {
  try {
    return await Bun.file(path).text();
  } catch {
    return undefined;
  }
}

function globalGitIgnorePath(): string | undefined {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  if (xdgConfigHome !== undefined && xdgConfigHome !== "") {
    return join(xdgConfigHome, "git", "ignore");
  }

  const home = process.env.HOME;
  if (home !== undefined && home !== "") {
    return join(home, ".config", "git", "ignore");
  }

  return undefined;
}

function relFromBase(absPath: string, baseAbs: string): string | undefined {
  if (absPath === baseAbs) {
    return "";
  }

  const prefix = baseAbs.endsWith("/") ? baseAbs : `${baseAbs}/`;
  if (!absPath.startsWith(prefix)) {
    return undefined;
  }

  return absPath.slice(prefix.length);
}

function ignoreVerdict(
  matcher: Ignore,
  repoRootAbs: string,
  absPath: string,
  isDirectory: boolean
): { ignored: boolean; unignored: boolean } {
  const path = relFromBase(absPath, repoRootAbs);
  if (path === undefined || path === "") {
    return { ignored: false, unignored: false };
  }
  const result = matcher.test(isDirectory ? `${path}/` : path);
  return { ignored: result.ignored, unignored: result.unignored };
}

function pushRules(out: string[], content: string): void {
  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === "" || line.startsWith("#")) {
      continue;
    }
    out.push(line);
  }
}

// Rewrites a nested .gitignore relative to the repo root. Slash-free patterns gain `**/`
// so they still match at any depth below their directory.
function reanchorRules(
  content: string,
  basePrefix: string,
  out: string[]
): void {
  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === "" || line.startsWith("#")) {
      continue;
    }

    let negated = false;
    let pattern = line;
    if (pattern.startsWith("!")) {
      negated = true;
      pattern = pattern.slice(1);
    }
    if (pattern === "") {
      continue;
    }

    let body: string;
    if (pattern.startsWith("/")) {
      body = basePrefix + pattern.slice(1);
    } else {
      const core = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
      body = core.includes("/")
        ? basePrefix + pattern
        : basePrefix + "**/" + pattern;
    }

    out.push(negated ? `!${body}` : body);
  }
}

function addDirRules(
  out: string[],
  content: string,
  dirAbs: string,
  repoRootAbs: string
): void {
  const dirRel = relFromBase(dirAbs, repoRootAbs);
  if (dirRel === undefined || dirRel === "") {
    pushRules(out, content);
  } else {
    reanchorRules(content, `${dirRel}/`, out);
  }
}

/** `.git` is a directory in a normal repo and a file in a worktree or submodule. */
function isRepoRoot(dir: string): Promise<boolean> {
  return stat(join(dir, ".git")).then(
    () => true,
    () => false
  );
}

/** `dir`'s `.git` file points into `<ancestor>/.git/worktrees/`: a checkout of a project that encloses it. */
async function isSameProjectWorktree(dir: string): Promise<boolean> {
  try {
    const pointer = /^gitdir: (.+)$/m.exec(
      await Bun.file(join(dir, ".git")).text()
    );
    if (pointer === null) {
      return false;
    }
    const [gitDir, realDir] = await Promise.all([
      realpath(resolve(dir, pointer[1]!.trim())),
      realpath(dir),
    ]);
    const worktrees = dirname(gitDir);
    const dotGit = dirname(worktrees);
    return (
      basename(worktrees) === "worktrees" &&
      basename(dotGit) === ".git" &&
      realDir.startsWith(`${dirname(dotGit)}/`)
    );
  } catch {
    return false;
  }
}

/** A repository root that is not a worktree of an enclosing project. */
async function isNestedRepo(dir: string): Promise<boolean> {
  return (await isRepoRoot(dir)) && !(await isSameProjectWorktree(dir));
}

async function findRepoRoot(start: string): Promise<string | undefined> {
  let dir = start;
  for (;;) {
    if (await isRepoRoot(dir)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

// Precedence order: global excludes, then .git/info/exclude, then the repo's own .gitignore.
async function repoBaseRules(
  repoAbs: string,
  globalGitIgnore: string | undefined
): Promise<string[]> {
  const rules: string[] = [];
  if (globalGitIgnore !== undefined) {
    pushRules(rules, globalGitIgnore);
  }
  const [infoExclude, repoGitIgnore] = await Promise.all([
    readIgnoreFile(join(repoAbs, ".git", "info", "exclude")),
    readIgnoreFile(join(repoAbs, ".gitignore")),
  ]);
  if (infoExclude !== undefined) {
    pushRules(rules, infoExclude);
  }
  if (repoGitIgnore !== undefined) {
    pushRules(rules, repoGitIgnore);
  }
  return rules;
}

async function contents(dir: Dir): Promise<WalkChildren<Dir>> {
  const out = {
    dirs: [] as Dir[],
    files: [] as string[],
    skippedRepos: [] as string[],
  };
  let entries;
  try {
    entries = await readdir(dir.abs, { withFileTypes: true });
  } catch {
    return out;
  }

  const { policy } = dir;
  let inRepo = dir.inRepo;
  let repoRootAbs = dir.repoRootAbs;
  let rules = dir.ignoreRules;
  let matcher = dir.matcher;

  const hasDotGit = entries.some((e) => e.name === ".git");

  if (policy.useIgnore) {
    if (hasDotGit) {
      // A nested repo does not inherit its parent's rules.
      inRepo = true;
      repoRootAbs = dir.abs;
      rules = await repoBaseRules(dir.abs, policy.globalGitIgnore);
      matcher = ignore().add(rules);
    } else if (inRepo) {
      const hasGitIgnore = entries.some(
        (e) => e.isFile() && e.name === ".gitignore"
      );
      if (hasGitIgnore) {
        const content = await readIgnoreFile(join(dir.abs, ".gitignore"));
        if (content !== undefined) {
          rules = rules.slice();
          addDirRules(rules, content, dir.abs, repoRootAbs);
          matcher = ignore().add(rules);
        }
      }
    }
  }

  for (const entry of entries) {
    const name = entry.name;
    const relPath = dir.rel === "" ? name : `${dir.rel}/${name}`;
    const isDir = entry.isDirectory();
    const isSymlink = entry.isSymbolicLink();

    if (name === ".git") {
      continue;
    }

    const needsAbs = isDir || (policy.useIgnore && inRepo);
    const childAbs = needsAbs ? join(dir.abs, name) : "";

    const verdict =
      policy.useIgnore && inRepo
        ? ignoreVerdict(matcher, repoRootAbs, childAbs, isDir)
        : { ignored: false, unignored: false };

    // A `!` negation re-includes a dotfile, as in git/fd.
    if (
      !policy.includeDotfiles &&
      name.charCodeAt(0) === 0x2e /* "." */ &&
      !verdict.unignored
    ) {
      continue;
    }

    if (verdict.ignored) {
      if (!isDir || !(await isNestedRepo(childAbs))) {
        continue;
      }
      if (!policy.includeNestedRepos) {
        out.skippedRepos.push(relPath);
        continue;
      }
    }

    if (isDir) {
      // Never follow symlinked dirs: cycles.
      if (isSymlink) {
        continue;
      }

      out.dirs.push({
        abs: childAbs,
        rel: relPath,
        policy,
        inRepo,
        repoRootAbs,
        ignoreRules: rules,
        matcher,
      });
      continue;
    }

    if (entry.isFile() || isSymlink) {
      out.files.push(relPath);
    }
  }
  return out;
}

/** The folder's visible contents under the same rules the walk applies. */
function children(dir: WalkDir): Promise<WalkChildren> {
  return contents(dir as Dir);
}

// Refill on each completion: fixed workers would exit early while the stack holds only the root.
function drain(ctx: WalkContext): Promise<void> {
  let inFlight = 0;
  return new Promise<void>((resolve, reject) => {
    const pump = (): void => {
      if (ctx.result.length >= ctx.limit) {
        ctx.stack.length = 0;
      }
      while (inFlight < CONCURRENCY && ctx.stack.length > 0) {
        const currentDir = ctx.stack.pop()!;
        inFlight++;
        contents(currentDir).then((found) => {
          for (const dir of found.dirs) {
            ctx.stack.push(dir);
          }
          for (const file of found.files) {
            ctx.result.push(file);
          }
          for (const repo of found.skippedRepos) {
            ctx.skippedRepos.push(repo);
          }
          inFlight--;
          pump();
        }, reject);
      }
      if (inFlight === 0 && ctx.stack.length === 0) {
        resolve();
      }
    };
    pump();
  });
}

/** Rules from a repo strictly above `root`; `root`'s own .gitignore is read by `contents`. */
async function enclosingRepo(
  root: string,
  globalGitIgnore: string | undefined
): Promise<
  { readonly repoRoot: string; readonly rules: string[] } | undefined
> {
  const repoRoot = await findRepoRoot(root);
  if (repoRoot === undefined || repoRoot === root) {
    return undefined;
  }
  const rules = await repoBaseRules(repoRoot, globalGitIgnore);

  // Shallowest first: gitignore precedence is by depth.
  const intermediates: string[] = [];
  let dir = dirname(root);
  while (dir !== repoRoot && dir.length > repoRoot.length) {
    intermediates.push(dir);
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  intermediates.reverse();

  for (const dirAbs of intermediates) {
    const content = await readIgnoreFile(join(dirAbs, ".gitignore"));
    if (content !== undefined) {
      addDirRules(rules, content, dirAbs, repoRoot);
    }
  }
  return { repoRoot, rules };
}

async function rootDir(root: string, opts?: EnumerateOptions): Promise<Dir> {
  const useIgnore = !(opts?.includeIgnored ?? false);

  let globalGitIgnore: string | undefined;
  if (useIgnore) {
    const pathname = globalGitIgnorePath();
    globalGitIgnore =
      pathname === undefined ? undefined : await readIgnoreFile(pathname);
  }

  const enclosing = useIgnore
    ? await enclosingRepo(root, globalGitIgnore)
    : undefined;

  return {
    abs: root,
    rel: "",
    policy: {
      includeDotfiles: opts?.includeDotfiles ?? false,
      useIgnore,
      includeNestedRepos: opts?.includeNestedRepos ?? false,
      globalGitIgnore,
    },
    inRepo: enclosing !== undefined,
    repoRootAbs: enclosing?.repoRoot ?? root,
    ignoreRules: enclosing?.rules ?? [],
    matcher:
      enclosing === undefined ? EMPTY_MATCHER : ignore().add(enclosing.rules),
  };
}

/** The folder at root-relative `rel`, or undefined when the walk would not enter it. */
async function folder(
  root: string,
  rel: string,
  opts?: EnumerateOptions
): Promise<WalkDir | undefined> {
  let dir = await rootDir(root, opts);
  for (const segment of rel === "" ? [] : rel.split("/")) {
    const path = dir.rel === "" ? segment : `${dir.rel}/${segment}`;
    const next = (await contents(dir)).dirs.find((child) => child.rel === path);
    if (next === undefined) {
      return undefined;
    }
    dir = next;
  }
  return dir;
}

/** One walk of `root`: its files, the repository roots it reaches, and the ignored ones it skips. */
async function walk(root: string, opts?: EnumerateOptions): Promise<FileWalk> {
  const ctx: WalkContext = {
    limit: opts?.limit ?? Number.POSITIVE_INFINITY,
    stack: [await rootDir(root, opts)],
    result: [],
    skippedRepos: [],
  };

  await drain(ctx);

  return {
    files: ctx.result,
    skippedRepos: ctx.skippedRepos.toSorted(),
  };
}

/** All files under `root` as root-relative POSIX paths; `.gitignore` is honored only inside a repo. */
async function enumerate(
  root: string,
  opts?: EnumerateOptions
): Promise<readonly string[]> {
  return (await walk(root, opts)).files;
}

export const FileEnumerator = {
  enumerate,
  walk,
  folder,
  children,
  isRepoRoot,
  isNestedRepo,
};
