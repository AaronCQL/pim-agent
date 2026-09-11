import { Lines } from "./Lines";
import { Proc, type ProcResult } from "./Proc";

export type GitState = {
  readonly branch: string | null;
  /** Paths `git status` lists as changed; zero is a clean tree. */
  readonly dirtyCount: number;
  readonly ahead: number;
  readonly behind: number;
};

/** One local branch, as `listBranches` ranks and labels it. */
export type GitBranch = {
  readonly name: string;
  readonly current: boolean;
  /** The branch `origin/HEAD` points at, or the first of `main`/`master`/`trunk` that exists. */
  readonly isDefault: boolean;
  /** Its last commit, in epoch seconds. */
  readonly updatedAt: number;
  readonly ahead: number;
  readonly behind: number;
  /** It tracked a remote branch that has since been deleted, so its work has usually landed. */
  readonly gone: boolean;
  readonly merged: boolean;
  /** Checked out in another worktree, where git will refuse to take it from. */
  readonly worktree: boolean;
};

export type GitOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

const EMPTY: GitState = {
  branch: null,
  dirtyCount: 0,
  ahead: 0,
  behind: 0,
};

const FIELD = "%00";

const BRANCH_FORMAT = [
  "%(refname:short)",
  "%(committerdate:unix)",
  "%(upstream:track)",
  "%(worktreepath)",
  "%(HEAD)",
].join(FIELD);

const REFLOG_FORMAT = `%gd${FIELD}%gs`;

const REFLOG_DEPTH = 300;

const FALLBACK_DEFAULTS = ["main", "master", "trunk"] as const;

const BRANCH_LIMIT = 200;

const NETWORK_TIMEOUT_MS = 60_000;

const ERROR_LIMIT = 400;

/** No surface behind a daemon can answer a credential prompt, so every network call must fail instead of waiting on one. */
const NETWORK_ENV: Readonly<Record<string, string | undefined>> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: undefined,
  SSH_ASKPASS: undefined,
  SSH_ASKPASS_REQUIRE: "never",
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
};

function git(cwd: string, args: readonly string[]): Promise<ProcResult> {
  return Proc.run(["git", ...args], { cwd });
}

function network(cwd: string, args: readonly string[]): Promise<ProcResult> {
  return Proc.run(["git", ...args], {
    cwd,
    env: NETWORK_ENV,
    timeoutMs: NETWORK_TIMEOUT_MS,
  });
}

function parseStatus(text: string): GitState {
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  let dirtyCount = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length);
      branch = head === "(detached)" ? "detached" : head;
    } else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+)\s+-(\d+)/.exec(line);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (line.length > 0 && !line.startsWith("#")) {
      dirtyCount++;
    }
  }
  return { branch, dirtyCount, ahead, behind };
}

const AHEAD = /ahead (\d+)/;

const BEHIND = /behind (\d+)/;

const UNTRACKED = { ahead: 0, behind: 0, gone: false } as const;

function parseTrack(text: string): {
  readonly ahead: number;
  readonly behind: number;
  readonly gone: boolean;
} {
  if (text === "") {
    return UNTRACKED;
  }
  const ahead = AHEAD.exec(text);
  const behind = BEHIND.exec(text);
  return {
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
    gone: text.includes("gone"),
  };
}

/** What one `for-each-ref` line says; `rank` adds the two facts that need the whole list. */
type Ref = Omit<GitBranch, "isDefault" | "merged">;

function parseRefs(text: string): readonly Ref[] {
  const refs: Ref[] = [];
  for (const line of Lines.split(text)) {
    const [name, date, track, worktree, head] = line.split("\0");
    if (name === undefined || name === "") {
      continue;
    }
    refs.push({
      name,
      current: head === "*",
      updatedAt: Number(date ?? 0) || 0,
      ...parseTrack(track ?? ""),
      worktree: (worktree ?? "") !== "" && head !== "*",
    });
  }
  return refs;
}

const MOVING = "checkout: moving from ";

/** When each branch was last checked out, newest first, so a branch worked on without committing still ranks. */
function parseVisits(text: string): ReadonlyMap<string, number> {
  const visits = new Map<string, number>();
  for (const line of Lines.split(text)) {
    const [stamp, message] = line.split("\0");
    if (message === undefined || !message.startsWith(MOVING)) {
      continue;
    }
    const at = Number(/\{(\d+)\}/.exec(stamp ?? "")?.[1] ?? 0);
    if (at === 0) {
      continue;
    }
    const names = message.slice(MOVING.length).split(" to ");
    for (const name of names) {
      if (name !== "" && !visits.has(name)) {
        visits.set(name, at);
      }
    }
  }
  return visits;
}

function rank(
  refs: readonly Ref[],
  visits: ReadonlyMap<string, number>,
  merged: ReadonlySet<string>,
  head: string | undefined
): readonly GitBranch[] {
  const touchedAt = (ref: Ref): number =>
    Math.max(ref.updatedAt, visits.get(ref.name) ?? 0);
  return [...refs]
    .sort((a, b) => {
      if ((a.name === head) !== (b.name === head)) {
        return a.name === head ? -1 : 1;
      }
      return touchedAt(b) - touchedAt(a);
    })
    .slice(0, BRANCH_LIMIT)
    .map((ref) => ({
      ...ref,
      isDefault: ref.name === head,
      merged: merged.has(ref.name),
    }));
}

async function remoteOf(cwd: string): Promise<string | undefined> {
  const { code, stdout } = await git(cwd, ["remote"]);
  if (code !== 0) {
    return undefined;
  }
  const remotes = Lines.split(stdout);
  if (remotes.includes("origin")) {
    return "origin";
  }
  return remotes.length === 1 ? remotes[0] : undefined;
}

/** What the remote calls its trunk; absent when no remote names one. */
async function remoteHead(cwd: string): Promise<string | undefined> {
  const remote = await remoteOf(cwd);
  if (remote === undefined) {
    return undefined;
  }
  const { code, stdout } = await git(cwd, [
    "symbolic-ref",
    "--short",
    `refs/remotes/${remote}/HEAD`,
  ]);
  const name = stdout.trim().slice(remote.length + 1);
  return code === 0 && name !== "" ? name : undefined;
}

async function mergedInto(
  cwd: string,
  head: string
): Promise<ReadonlySet<string>> {
  const { code, stdout } = await git(cwd, [
    "for-each-ref",
    "--merged",
    head,
    "--format",
    "%(refname:short)",
    "refs/heads/",
  ]);
  return new Set(code === 0 ? Lines.split(stdout) : []);
}

/** Every local branch, trunk first and the rest by the last time they were committed to or checked out. */
async function listBranches(cwd: string): Promise<readonly GitBranch[]> {
  const [refs, log, remote] = await Promise.all([
    git(cwd, ["for-each-ref", "--format", BRANCH_FORMAT, "refs/heads/"]),
    git(cwd, ["reflog", "--date=unix", `-n${REFLOG_DEPTH}`, REFLOG_FORMAT]),
    remoteHead(cwd),
  ]);
  if (refs.code !== 0) {
    return [];
  }
  const parsed = parseRefs(refs.stdout);
  const has = (name: string): boolean =>
    parsed.some((ref) => ref.name === name);
  const head = remote ?? FALLBACK_DEFAULTS.find(has);
  return rank(
    parsed,
    parseVisits(log.stdout),
    head !== undefined && has(head) ? await mergedInto(cwd, head) : new Set(),
    head
  );
}

function failure(result: ProcResult, fallback: string): string {
  if (result.timedOut) {
    return `timed out after ${NETWORK_TIMEOUT_MS / 1000}s — the remote never answered`;
  }
  const said = (result.stderr.trim() || result.stdout.trim()).replace(
    /^(?:error|fatal):\s*/,
    ""
  );
  return said === "" ? fallback : said.slice(0, ERROR_LIMIT);
}

function outcome(result: ProcResult, fallback: string): GitOutcome {
  return result.code === 0
    ? { ok: true }
    : { ok: false, error: failure(result, fallback) };
}

async function checkout(cwd: string, branch: string): Promise<GitOutcome> {
  return outcome(
    await git(cwd, ["checkout", branch, "--"]),
    `could not switch to ${branch}`
  );
}

async function fetch(cwd: string): Promise<GitOutcome> {
  return outcome(await network(cwd, ["fetch", "--quiet"]), "could not fetch");
}

async function pull(cwd: string): Promise<GitOutcome> {
  return outcome(
    await network(cwd, ["pull", "--ff-only"]),
    "could not pull; the branch may have diverged"
  );
}

/** Publishes the branch, adopting the remote as its upstream the first time it is pushed. */
async function push(cwd: string): Promise<GitOutcome> {
  const [head, upstream] = await Promise.all([
    git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    git(cwd, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]),
  ]);
  if (head.code !== 0) {
    return {
      ok: false,
      error: "HEAD is detached, so there is nothing to push",
    };
  }
  if (upstream.code === 0) {
    return outcome(await network(cwd, ["push"]), "could not push");
  }
  const remote = await remoteOf(cwd);
  if (remote === undefined) {
    return {
      ok: false,
      error: "no remote to push to; name one with `git remote add`",
    };
  }
  return outcome(
    await network(cwd, ["push", "--set-upstream", remote, "HEAD"]),
    `could not push to ${remote}`
  );
}

async function fetchStatus(cwd: string): Promise<GitState> {
  try {
    const { code, stdout } = await git(cwd, [
      // Or the chip's own read takes `index.lock` and fails the checkout beside it.
      "--no-optional-locks",
      "status",
      "--porcelain=v2",
      "--branch",
    ]);
    return code === 0 ? parseStatus(stdout) : EMPTY;
  } catch {
    return EMPTY;
  }
}

/** The cwd's git state, for the TUI footer and the web's branch menu. */
export const Git = {
  EMPTY,
  parseStatus,
  parseRefs,
  parseVisits,
  fetchStatus,
  listBranches,
  checkout,
  fetch,
  pull,
  push,
};
