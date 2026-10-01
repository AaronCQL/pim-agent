import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import ignore, { type Ignore } from "ignore";

const CONCURRENCY = 32;

export type EnumerateOptions = {
  readonly includeDotfiles?: boolean;
  readonly includeIgnored?: boolean;
};

type StackEntry = {
  readonly abs: string;
  readonly rel: string;
  readonly inRepo: boolean;
  readonly repoRootAbs: string;
  readonly ignoreRules: string[];
  readonly matcher: Ignore;
};

const EMPTY_MATCHER = ignore();

type WalkContext = {
  includeDotfiles: boolean;
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

async function findRepoRoot(start: string): Promise<string | undefined> {
  let dir = start;
  for (;;) {
    // `.git` is a directory in a normal repo and a file in a worktree.
    if (
      await stat(join(dir, ".git")).then(
        () => true,
        () => false
      )
    ) {
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

async function processDir(
  ctx: WalkContext,
  currentDir: StackEntry
): Promise<void> {
  let entries;
  try {
    entries = await readdir(currentDir.abs, { withFileTypes: true });
  } catch {
    return;
  }

  let inRepo = currentDir.inRepo;
  let repoRootAbs = currentDir.repoRootAbs;
  let rules = currentDir.ignoreRules;
  let matcher = currentDir.matcher;

  if (ctx.useIgnore) {
    const hasDotGit = entries.some((e) => e.name === ".git");
    if (hasDotGit) {
      // A nested repo does not inherit its parent's rules.
      inRepo = true;
      repoRootAbs = currentDir.abs;
      rules = await repoBaseRules(currentDir.abs, ctx.globalGitIgnore);
      matcher = ignore().add(rules);
    } else if (inRepo) {
      const hasGitIgnore = entries.some(
        (e) => e.isFile() && e.name === ".gitignore"
      );
      if (hasGitIgnore) {
        const content = await readIgnoreFile(
          join(currentDir.abs, ".gitignore")
        );
        if (content !== undefined) {
          rules = rules.slice();
          addDirRules(rules, content, currentDir.abs, repoRootAbs);
          matcher = ignore().add(rules);
        }
      }
    }
  }

  for (const entry of entries) {
    const name = entry.name;
    const relPath = currentDir.rel === "" ? name : `${currentDir.rel}/${name}`;
    const isDir = entry.isDirectory();
    const isSymlink = entry.isSymbolicLink();

    if (name === ".git") {
      continue;
    }

    const needsAbs = isDir || (ctx.useIgnore && inRepo);
    const childAbs = needsAbs ? join(currentDir.abs, name) : "";

    const verdict =
      ctx.useIgnore && inRepo
        ? ignoreVerdict(matcher, repoRootAbs, childAbs, isDir)
        : { ignored: false, unignored: false };

    // A `!` negation re-includes a dotfile, as in git/fd.
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
      // Never follow symlinked dirs: cycles.
      if (isSymlink) {
        continue;
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
    }
  }
}

// Refill on each completion: fixed workers would exit early while the stack holds only the root.
function drain(ctx: WalkContext): Promise<void> {
  let inFlight = 0;
  return new Promise<void>((resolve, reject) => {
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

/** Rules from a repo strictly above `root`; `root`'s own .gitignore is read by processDir. */
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

/** All files under `root` as root-relative POSIX paths; `.gitignore` is honored only inside a repo. */
async function enumerate(
  root: string,
  opts?: EnumerateOptions
): Promise<string[]> {
  const includeDotfiles = opts?.includeDotfiles ?? false;
  const includeIgnored = opts?.includeIgnored ?? false;
  const useIgnore = !includeIgnored;

  let globalGitIgnore: string | undefined;
  if (useIgnore) {
    const pathname = globalGitIgnorePath();
    globalGitIgnore =
      pathname === undefined ? undefined : await readIgnoreFile(pathname);
  }

  const enclosing = useIgnore
    ? await enclosingRepo(root, globalGitIgnore)
    : undefined;

  const ctx: WalkContext = {
    includeDotfiles,
    useIgnore,
    globalGitIgnore,
    stack: [
      {
        abs: root,
        rel: "",
        inRepo: enclosing !== undefined,
        repoRootAbs: enclosing?.repoRoot ?? root,
        ignoreRules: enclosing?.rules ?? [],
        matcher:
          enclosing === undefined
            ? EMPTY_MATCHER
            : ignore().add(enclosing.rules),
      },
    ],
    result: [],
  };

  await drain(ctx);

  return ctx.result;
}

export const FileEnumerator = { enumerate };
