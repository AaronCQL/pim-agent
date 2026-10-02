import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { Lines } from "./Lines";
import { Proc, type ProcOptions, type ProcResult } from "./Proc";

export type GitState = {
  readonly branch: string | null;
  readonly dirtyCount: number;
  readonly ahead: number;
  readonly behind: number;
  /** Hash of HEAD, the changed paths and their stats; also moves when an already-dirty file is edited again. */
  readonly revision: string;
};

export type GitBranch = {
  readonly name: string;
  readonly current: boolean;
  /** `origin/HEAD`'s target, else the first of `main`/`master`/`trunk` that exists. */
  readonly isDefault: boolean;
  /** Last commit time, epoch seconds. */
  readonly updatedAt: number;
  readonly ahead: number;
  readonly behind: number;
  /** Its upstream branch was deleted. */
  readonly gone: boolean;
  readonly merged: boolean;
  /** Checked out in another worktree. */
  readonly worktree: boolean;
};

export type GitOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export type CommitRequest = {
  readonly message: string;
  /** Exactly what is committed; a rename lists both names. */
  readonly paths: readonly string[];
};

export type CommitResult =
  | { readonly ok: true; readonly sha: string }
  | { readonly ok: false; readonly error: string };

const EMPTY: GitState = {
  branch: null,
  dirtyCount: 0,
  ahead: 0,
  behind: 0,
  revision: "",
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

const COMMIT_TIMEOUT_MS = 120_000;

const ERROR_LIMIT = 400;

/** Fail instead of waiting on a credential prompt nobody can answer. */
const NETWORK_ENV: Readonly<Record<string, string | undefined>> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: undefined,
  SSH_ASKPASS: undefined,
  SSH_ASKPASS_REQUIRE: "never",
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
};

/** Hooks and signing must never open an editor. */
const COMMIT_OPTIONS: ProcOptions = {
  env: { GIT_EDITOR: "true" },
  timeoutMs: COMMIT_TIMEOUT_MS,
};

const NETWORK_TIMEOUT = `timed out after ${NETWORK_TIMEOUT_MS / 1000}s — the remote never answered`;

const COMMIT_TIMEOUT = `timed out after ${COMMIT_TIMEOUT_MS / 1000}s — a hook or a signing key is still waiting on something`;

function git(
  cwd: string,
  args: readonly string[],
  options: ProcOptions = {}
): Promise<ProcResult> {
  return Proc.run(["git", ...args], { cwd, ...options });
}

function network(cwd: string, args: readonly string[]): Promise<ProcResult> {
  return git(cwd, args, { env: NETWORK_ENV, timeoutMs: NETWORK_TIMEOUT_MS });
}

/** Index of the path field in each porcelain-v2 entry type. */
const PATH_FIELD: Readonly<Record<string, number>> = { "1": 8, "2": 9, u: 10 };

/** Only the first this-many changed paths are stat'd into the revision. */
const SAMPLE_LIMIT = 500;

function pathOf(line: string): string {
  const kind = line[0] ?? "";
  if (kind === "?" || kind === "!") {
    return line.slice(2);
  }
  const field = PATH_FIELD[kind];
  if (field === undefined) {
    return "";
  }
  // A rename carries the name it came from after a tab.
  return line.split(" ").slice(field).join(" ").split("\t")[0] ?? "";
}

function worktreeSample(cwd: string): (path: string) => string {
  return (path) => {
    const stats = statSync(join(cwd, path), { throwIfNoEntry: false });
    return stats === undefined ? "gone" : `${stats.mtimeMs}:${stats.size}`;
  };
}

function parseStatus(
  text: string,
  sample?: (path: string) => string
): GitState {
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  let dirtyCount = 0;
  const marks: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("# branch.oid ")) {
      marks.push(line);
    } else if (line.startsWith("# branch.head ")) {
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
      marks.push(line);
      const path = dirtyCount > SAMPLE_LIMIT ? "" : pathOf(line);
      if (sample !== undefined && path !== "") {
        marks.push(sample(path));
      }
    }
  }
  return {
    branch,
    dirtyCount,
    ahead,
    behind,
    revision: marks.length === 0 ? "" : Bun.hash(marks.join("\n")).toString(36),
  };
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

/** Last checkout time per branch, from the reflog. */
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

/** The remote's default branch, if it names one. */
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

/** Local branches: default first, then by last commit or checkout. */
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

/** git's own error text, else `fallback`, or `timeout` when it timed out. */
function failure(
  result: ProcResult,
  fallback: string,
  timeout = NETWORK_TIMEOUT
): string {
  if (result.timedOut) {
    return timeout;
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

/** True for an empty, absolute or `..` path. */
function escapes(path: string): boolean {
  return path === "" || isAbsolute(path) || path.split(/[/\\]/).includes("..");
}

/** Commits exactly `paths`; other changes, staged or not, are left alone. */
async function commit(
  cwd: string,
  request: CommitRequest
): Promise<CommitResult> {
  const message = request.message.trim();
  if (message === "") {
    return { ok: false, error: "a commit needs a message" };
  }
  if (request.paths.length === 0) {
    return { ok: false, error: "nothing was picked to commit" };
  }
  const outside = request.paths.find(escapes);
  if (outside !== undefined) {
    return {
      ok: false,
      error: `${outside === "" ? "an empty path" : outside} is not a path inside this repository`,
    };
  }
  // Add only paths on disk: `git add` rejects deleted paths and a rename's old
  // name, and `git commit -- <paths>` handles those itself.
  const onDisk = await Promise.all(
    request.paths.map((path) => Bun.file(join(cwd, path)).exists())
  );
  const addable = request.paths.filter((_, index) => onDisk[index]);
  if (addable.length > 0) {
    const staged = await git(
      cwd,
      ["add", "-A", "--", ...addable],
      COMMIT_OPTIONS
    );
    if (staged.code !== 0) {
      return {
        ok: false,
        error: failure(
          staged,
          "could not stage the picked files",
          COMMIT_TIMEOUT
        ),
      };
    }
  }
  const written = await git(
    cwd,
    ["commit", "-m", message, "--", ...request.paths],
    COMMIT_OPTIONS
  );
  if (written.code !== 0) {
    return {
      ok: false,
      error: failure(written, "could not commit", COMMIT_TIMEOUT),
    };
  }
  const head = await git(cwd, ["rev-parse", "--short", "HEAD"]);
  const sha = head.stdout.trim();
  return head.code === 0 && sha !== ""
    ? { ok: true, sha }
    : {
        ok: false,
        error: failure(head, "the commit landed but its sha is unreadable"),
      };
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

/** Undefined when the branch has no upstream or HEAD is detached. */
async function upstreamOf(cwd: string): Promise<string | undefined> {
  const { code, stdout } = await git(cwd, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ]);
  const name = stdout.trim();
  return code === 0 && name !== "" ? name : undefined;
}

/** Sets the upstream on the first push. */
async function push(cwd: string): Promise<GitOutcome> {
  const [head, upstream] = await Promise.all([
    git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    upstreamOf(cwd),
  ]);
  if (head.code !== 0) {
    return {
      ok: false,
      error: "HEAD is detached, so there is nothing to push",
    };
  }
  if (upstream !== undefined) {
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
      // Avoids taking `index.lock`, which would fail a concurrent checkout.
      "--no-optional-locks",
      "status",
      "--porcelain=v2",
      "--branch",
    ]);
    return code === 0 ? parseStatus(stdout, worktreeSample(cwd)) : EMPTY;
  } catch {
    return EMPTY;
  }
}

export const Git = {
  EMPTY,
  parseStatus,
  parseRefs,
  parseVisits,
  failure,
  fetchStatus,
  listBranches,
  upstreamOf,
  checkout,
  commit,
  fetch,
  pull,
  push,
};
