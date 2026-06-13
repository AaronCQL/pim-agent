import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import ignore, { type Ignore } from "ignore";

/**
 * Max in-flight `readdir` syscalls.
 */
const CONCURRENCY = 32;

/**
 * Options that decide what the walk enumerates.
 */
export type EnumerateOptions = {
  /**
   * Include dot-prefixed files/dirs such as `.env`, `.github`. Default false.
   */
  readonly includeDotfiles?: boolean;
  /**
   * Include gitignored / normally-ignored paths such as `node_modules`. Default false.
   */
  readonly includeIgnored?: boolean;
  /**
   * Emit directories as well as files, each marked with a trailing `/`. Default false.
   */
  readonly includeDirectories?: boolean;
};

type StackEntry = {
  /**
   * Absolute path of the directory.
   */
  abs: string;
  /**
   * Root-relative POSIX path of the directory ("" for root), no trailing slash.
   */
  rel: string;
  /**
   * Whether this directory lies within a git repository. When false, no
   * `.gitignore` files are honored — matching git/fd, which treat ignore files
   * as inert outside a repository.
   */
  inRepo: boolean;
  /**
   * Absolute path of the git repository root the ignore rules are anchored to.
   * Paths are tested relative to this. Only meaningful when `inRepo`.
   */
  repoRootAbs: string;
  /**
   * Every gitignore pattern that applies to this subtree, ordered shallowest
   * (repo root) to deepest, each already re-anchored to be relative to
   * `repoRootAbs`. Held so a nested `.gitignore` can extend it without losing
   * the ancestor rules. Empty when `inRepo` is false.
   *
   * Keeping all of a repo's rules in a single matcher (rather than one matcher
   * per `.gitignore`) is what lets negations work across files: a `build/`
   * exclusion at the repo root and a `!build/` re-inclusion in a nested
   * `.gitignore` are only resolved correctly when evaluated together.
   */
  ignoreRules: string[];
  /**
   * Matcher built from `ignoreRules`; tests paths relative to `repoRootAbs`.
   */
  matcher: Ignore;
};

/** Reused for directories outside any repo, where no rules apply. */
const EMPTY_MATCHER = ignore();

/**
 * Shared mutable state threaded through one `enumerate` walk.
 */
type WalkContext = {
  includeDotfiles: boolean;
  includeDirectories: boolean;
  useIgnore: boolean;
  globalGitIgnore: string | undefined;
  stack: StackEntry[];
  result: string[];
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

/**
 * Path of `absPath` relative to `baseAbs` (POSIX), or undefined if `absPath`
 * is not within `baseAbs`. Returns "" when they are the same directory.
 */
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

/**
 * Verdict for one path against a repo's combined matcher. `ignored` is the net
 * decision; `unignored` is true when a `!` negation rule was the last to match,
 * i.e. the path is explicitly re-included. The two are distinct because a
 * negation can re-include a path that would otherwise be hidden as a dotfile.
 */
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

/**
 * Append the non-empty, non-comment lines of `content` to `out` verbatim. Used
 * for rules already anchored at the repo root (the repo's own `.gitignore`,
 * `.git/info/exclude`, and global excludes).
 */
function pushRules(out: string[], content: string): void {
  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === "" || line.startsWith("#")) {
      continue;
    }
    out.push(line);
  }
}

/**
 * Re-anchor each pattern of a nested `.gitignore` so it is relative to the repo
 * root rather than to the `.gitignore`'s own directory, appending to `out`.
 * `basePrefix` is the `.gitignore`'s repo-root-relative directory path with a
 * trailing slash (e.g. `"engine/src/"`).
 *
 * Mirrors gitignore anchoring rules: a pattern with a leading slash, or one
 * containing a non-trailing slash, is anchored to the `.gitignore`'s directory,
 * so it just gains the prefix; a pattern with no slash (or only a trailing one)
 * matches at any depth below that directory, so it gains a "prefix + doubled
 * star + slash" lead-in to match through intervening directories.
 */
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

/**
 * Nearest ancestor of `start` (inclusive) that contains a `.git` entry, i.e.
 * the git repository owning `start`, or undefined if `start` is not in a repo.
 * A `.git` may be a directory (normal clone) or a file (worktree/submodule).
 */
async function findRepoRoot(start: string): Promise<string | undefined> {
  let dir = start;
  for (;;) {
    if (await Bun.file(join(dir, ".git")).exists()) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * Build the base rule set for a repository rooted at `repoAbs`: global excludes,
 * then .git/info/exclude, then the repo root's own .gitignore — appended in that
 * precedence order. All are anchored at the repo root already, so no
 * re-anchoring is needed.
 */
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

/**
 * Read one directory: collect its files and queue its subdirectories, honoring
 * ignore rules.
 */
async function processDir(
  ctx: WalkContext,
  currentDir: StackEntry
): Promise<void> {
  let entries;
  try {
    entries = await readdir(currentDir.abs, { withFileTypes: true });
  } catch {
    // Unreadable directory (permissions, race): skip it.
    return;
  }

  let inRepo = currentDir.inRepo;
  let repoRootAbs = currentDir.repoRootAbs;
  let rules = currentDir.ignoreRules;
  let matcher = currentDir.matcher;

  if (ctx.useIgnore) {
    const hasDotGit = entries.some((e) => e.name === ".git");
    if (hasDotGit) {
      // A .git here marks a repository boundary. Start a fresh rule set for
      // this repo, discarding any inherited (parent-repo) rules.
      inRepo = true;
      repoRootAbs = currentDir.abs;
      rules = await repoBaseRules(currentDir.abs, ctx.globalGitIgnore);
      matcher = ignore().add(rules);
    } else if (inRepo) {
      // Within a repo, a nested .gitignore extends the rules for this subtree.
      const hasGitIgnore = entries.some(
        (e) => e.isFile() && e.name === ".gitignore"
      );
      if (hasGitIgnore) {
        const content = await readIgnoreFile(
          join(currentDir.abs, ".gitignore")
        );
        if (content !== undefined) {
          const dirRel = relFromBase(currentDir.abs, repoRootAbs);
          const next = rules.slice();
          if (dirRel === undefined || dirRel === "") {
            pushRules(next, content);
          } else {
            reanchorRules(content, `${dirRel}/`, next);
          }
          rules = next;
          matcher = ignore().add(rules);
        }
      }
    }
    // When !inRepo, .gitignore files are not honored: rules stays empty.
  }

  for (const entry of entries) {
    const name = entry.name;
    const relPath = currentDir.rel === "" ? name : `${currentDir.rel}/${name}`;
    const isDir = entry.isDirectory();
    const isSymlink = entry.isSymbolicLink();

    // Pruned regardless of includeDotfiles.
    if (name === ".git") {
      continue;
    }

    // Skip the join unless the abs path is actually needed below.
    const needsAbs = isDir || (ctx.useIgnore && inRepo);
    const childAbs = needsAbs ? join(currentDir.abs, name) : "";

    // One ignore evaluation per entry, reused for both the dotfile rule and the
    // ignore prune below.
    const verdict =
      ctx.useIgnore && inRepo
        ? ignoreVerdict(matcher, repoRootAbs, childAbs, isDir)
        : { ignored: false, unignored: false };

    // Dot-prefixed entries are hidden by default, but — like git/fd — an
    // explicit `!` negation in a .gitignore re-includes them.
    if (
      !ctx.includeDotfiles &&
      name.charCodeAt(0) === 0x2e /* "." */ &&
      !verdict.unignored
    ) {
      continue;
    }

    if (verdict.ignored) {
      continue;
    }

    if (isDir) {
      // Do not follow symlinked dirs, to avoid cycles.
      if (isSymlink) {
        continue;
      }

      if (ctx.includeDirectories) {
        ctx.result.push(`${relPath}/`);
      }

      ctx.stack.push({
        abs: childAbs,
        rel: relPath,
        inRepo,
        repoRootAbs,
        ignoreRules: rules,
        matcher,
      });
      continue;
    }

    if (entry.isFile() || isSymlink) {
      ctx.result.push(relPath);
      continue;
    }

    // Other dirent types (fifo, socket, block/char device) are ignored.
  }
}

/**
 * Bounded-concurrency pump: keep up to CONCURRENCY `processDir` calls in
 * flight. Each completion refills freed slots from the shared stack, which
 * grows as directories are discovered. A simple worker loop can't be used
 * here: at startup the stack holds only the root, so all but one worker
 * would drain it and exit before any children were pushed.
 */
function drain(ctx: WalkContext): Promise<void> {
  let inFlight = 0;
  return new Promise<void>((resolve, reject) => {
    // Self-referential to refill slots on each completion; must close over
    // the executor's resolve/reject, so it stays nested here.
    const pump = (): void => {
      while (inFlight < CONCURRENCY && ctx.stack.length > 0) {
        const currentDir = ctx.stack.pop()!;
        inFlight++;
        processDir(ctx, currentDir).then(() => {
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

export class FileEnumerator {
  /**
   * Enumerate all files under `root` as an array of root-relative POSIX paths.
   *
   * Descent is async with a bounded concurrency cap: up to `CONCURRENCY`
   * `readdir` syscalls are in flight at once, all pulling from a shared stack,
   * so directory-read latency overlaps instead of running one-at-a-time.
   *
   * Gitignore handling is repo-aware, matching git/fd: a `.gitignore` is only
   * honored within a git repository, each nested `.git` is a boundary that
   * resets the ignore scope (a child repo does not inherit its parent's rules),
   * and if `root` itself sits inside a repository the enclosing rules are
   * seeded. A `.gitignore` with no enclosing repo is inert, matching git/fd.
   */
  public static async enumerate(
    root: string,
    opts?: EnumerateOptions
  ): Promise<string[]> {
    const includeDotfiles = opts?.includeDotfiles ?? false;
    const includeIgnored = opts?.includeIgnored ?? false;
    const includeDirectories = opts?.includeDirectories ?? false;
    const useIgnore = !includeIgnored;

    // Global excludes (core.excludesFile / XDG). Read once; applies only within
    // a repository, anchored as if it were a .gitignore at the repo root.
    let globalGitIgnore: string | undefined;
    if (useIgnore) {
      const pathname = globalGitIgnorePath();
      globalGitIgnore =
        pathname === undefined ? undefined : await readIgnoreFile(pathname);
    }

    // Seed rules from any repository that ENCLOSES `root` (its .git lives at an
    // ancestor of root). The repo root's base rules plus every intermediate
    // .gitignore between it and root are applied. Root's own .gitignore, if any,
    // is added by processDir when root is walked. When root is itself a repo
    // root (or not in a repo at all), processDir handles it from a clean slate.
    let initialInRepo = false;
    let initialRepoRootAbs = root;
    let initialRules: string[] = [];
    if (useIgnore) {
      const repoRoot = await findRepoRoot(root);
      if (repoRoot !== undefined && repoRoot !== root) {
        initialInRepo = true;
        initialRepoRootAbs = repoRoot;
        initialRules = await repoBaseRules(repoRoot, globalGitIgnore);

        // Intermediate dirs strictly between repoRoot and root, shallowest first.
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
            const dirRel = relFromBase(dirAbs, repoRoot);
            if (dirRel === undefined || dirRel === "") {
              pushRules(initialRules, content);
            } else {
              reanchorRules(content, `${dirRel}/`, initialRules);
            }
          }
        }
      }
    }

    const ctx: WalkContext = {
      includeDotfiles,
      includeDirectories,
      useIgnore,
      globalGitIgnore,
      stack: [
        {
          abs: root,
          rel: "",
          inRepo: initialInRepo,
          repoRootAbs: initialRepoRootAbs,
          ignoreRules: initialRules,
          matcher: initialInRepo ? ignore().add(initialRules) : EMPTY_MATCHER,
        },
      ],
      result: [],
    };

    await drain(ctx);

    return ctx.result;
  }
}
