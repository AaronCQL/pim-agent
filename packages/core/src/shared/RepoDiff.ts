import { join } from "node:path";

import { DiffLines, type ToolDiffHunk } from "./DiffLines";
import { DiffPatch } from "./DiffPatch";
import type { GitMonitor } from "./GitMonitor";
import { Proc, type ProcResult } from "./Proc";

export type DiffBase =
  | { readonly kind: "worktree" }
  | { readonly kind: "unstaged" }
  | { readonly kind: "staged" }
  | { readonly kind: "commit"; readonly ref: string }
  | { readonly kind: "branch"; readonly ref: string };

export type ChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked";

/** One row of the change list; carries no hunks. */
export type ChangeSummary = {
  readonly path: string;
  /** Present only for a rename. */
  readonly oldPath?: string;
  readonly status: ChangeStatus;
  readonly added: number;
  readonly removed: number;
  readonly binary?: boolean;
  /** Blob SHAs the diff was computed against; anchors an outdated review comment. */
  readonly baseSha?: string;
  readonly headSha?: string;
  /** Changes whenever the file's content does, so a `seen` mark keyed to it clears itself. */
  readonly fingerprint: string;
};

export type ChangeList = {
  readonly base: DiffBase;
  readonly files: readonly ChangeSummary[];
  readonly added: number;
  readonly removed: number;
  /** More files exist than were returned. */
  readonly truncated?: boolean;
};

export type FileDiff = {
  readonly path: string;
  readonly hunks: readonly ToolDiffHunk[];
  readonly truncated?: boolean;
  readonly binary?: boolean;
};

const DEFAULT_CONTEXT = 3;

const FILE_LIMIT = 2000;

/** Past this an untracked file is reported as binary rather than read. */
const UNTRACKED_BYTE_LIMIT = 1_000_000;

const NUL_SCAN_BYTES = 8192;

const ERROR_LIMIT = 400;

const EMPTY_SHA = /^0+$/;

const BINARY_PATCH = /^(?:Binary files |GIT binary patch)/m;

/** One `git` read; `--no-optional-locks` or it takes `index.lock` and fails an agent's write beside it. */
function git(cwd: string, args: readonly string[]): Promise<ProcResult> {
  return Proc.run(["git", "--no-optional-locks", ...args], { cwd });
}

function failure(result: ProcResult, fallback: string): string {
  const said = (result.stderr.trim() || result.stdout.trim()).replace(
    /^(?:error|fatal):\s*/,
    ""
  );
  return said === "" ? fallback : said.slice(0, ERROR_LIMIT);
}

async function read(
  cwd: string,
  args: readonly string[],
  fallback: string
): Promise<string> {
  const result = await git(cwd, args);
  if (result.code !== 0) {
    throw new Error(failure(result, fallback));
  }
  return result.stdout;
}

/** What every `git diff` of this base is asked about; `branch` resolves to the merge base first. */
async function baseArgs(
  cwd: string,
  base: DiffBase
): Promise<readonly string[]> {
  switch (base.kind) {
    case "worktree":
      return ["HEAD"];
    case "unstaged":
      return [];
    case "staged":
      return ["--cached"];
    case "commit":
      return [base.ref];
    case "branch": {
      const merged = await read(
        cwd,
        ["merge-base", "HEAD", base.ref],
        `no commit is shared by HEAD and ${base.ref}`
      );
      return [merged.trim()];
    }
  }
}

type Entry = {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: ChangeStatus;
  readonly baseSha?: string;
  readonly headSha?: string;
};

type Counts = {
  readonly added: number;
  readonly removed: number;
  readonly binary: boolean;
};

function statusOf(code: string): ChangeStatus {
  const letter = code[0];
  if (letter === "A" || letter === "C") {
    return "added";
  }
  if (letter === "D") {
    return "deleted";
  }
  if (letter === "R") {
    return "renamed";
  }
  return "modified";
}

function shaOf(value: string | undefined): string | undefined {
  return value === undefined || value === "" || EMPTY_SHA.test(value)
    ? undefined
    : value;
}

/** `:<oldmode> <newmode> <oldsha> <newsha> <status>\0<path>\0`, a second path when the status is a rename or copy. */
function parseRaw(text: string): readonly Entry[] {
  const fields = text.split("\0");
  const entries: Entry[] = [];
  let index = 0;

  while (index < fields.length) {
    const header = fields[index];
    index += 1;
    if (header === undefined || !header.startsWith(":")) {
      continue;
    }
    const [, , baseSha, headSha, code] = header.slice(1).split(" ");
    const first = fields[index];
    index += 1;
    if (code === undefined || first === undefined || first === "") {
      continue;
    }
    const moved = code.startsWith("R") || code.startsWith("C");
    const second = moved ? fields[index] : undefined;
    if (moved) {
      index += 1;
    }
    const path = moved ? second : first;
    if (path === undefined || path === "") {
      continue;
    }
    const from = shaOf(baseSha);
    const to = shaOf(headSha);
    entries.push({
      path,
      ...(moved ? { oldPath: first } : {}),
      status: statusOf(code),
      ...(from === undefined ? {} : { baseSha: from }),
      ...(to === undefined ? {} : { headSha: to }),
    });
  }

  return entries;
}

/** `<added>\t<removed>\t<path>\0`; a rename leaves the path empty and follows with the old and new ones. */
function parseNumstat(text: string): ReadonlyMap<string, Counts> {
  const fields = text.split("\0");
  const counts = new Map<string, Counts>();
  let index = 0;

  while (index < fields.length) {
    const field = fields[index];
    index += 1;
    if (field === undefined || field === "") {
      continue;
    }
    const firstTab = field.indexOf("\t");
    const secondTab = field.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) {
      continue;
    }
    const added = field.slice(0, firstTab);
    const removed = field.slice(firstTab + 1, secondTab);
    let path = field.slice(secondTab + 1);
    if (path === "") {
      index += 1;
      path = fields[index] ?? "";
      index += 1;
    }
    if (path === "") {
      continue;
    }
    counts.set(path, {
      added: Number(added) || 0,
      removed: Number(removed) || 0,
      binary: added === "-",
    });
  }

  return counts;
}

/** Only the `?` entries of porcelain v2; a rename entry carries a second field that is a path, not a record. */
function parseUntracked(text: string): readonly string[] {
  const fields = text.split("\0");
  const paths: string[] = [];
  let index = 0;

  while (index < fields.length) {
    const field = fields[index];
    index += 1;
    if (field === undefined || field === "") {
      continue;
    }
    if (field.startsWith("2 ")) {
      index += 1;
      continue;
    }
    if (field.startsWith("? ")) {
      paths.push(field.slice(2));
    }
  }

  return paths;
}

function untrackedPaths(cwd: string): Promise<readonly string[]> {
  return read(
    cwd,
    ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
    "could not read the working tree"
  ).then(parseUntracked);
}

type Untracked = {
  readonly binary: boolean;
  readonly text: string;
  readonly lines: number;
  readonly mtimeMs: number;
};

async function readUntracked(cwd: string, path: string): Promise<Untracked> {
  const file = Bun.file(join(cwd, path));
  const mtimeMs = file.lastModified;
  const opaque: Untracked = { binary: true, text: "", lines: 0, mtimeMs };
  if (file.size > UNTRACKED_BYTE_LIMIT) {
    return opaque;
  }
  const bytes = await file.bytes().catch(() => undefined);
  if (bytes === undefined) {
    return opaque;
  }
  if (bytes.subarray(0, NUL_SCAN_BYTES).includes(0)) {
    return opaque;
  }
  const text = new TextDecoder().decode(bytes);
  return {
    binary: false,
    text,
    lines: DiffLines.fromText(text).lines.length,
    mtimeMs,
  };
}

function fingerprintOf(
  cwd: string,
  entry: Entry,
  added: number,
  removed: number
): string {
  if (entry.status === "deleted") {
    return `deleted:${entry.baseSha ?? ""}`;
  }
  if (entry.headSha !== undefined) {
    return entry.headSha;
  }
  return `${added}:${removed}:${Bun.file(join(cwd, entry.path)).lastModified}`;
}

function summaryOf(
  cwd: string,
  entry: Entry,
  counts: Counts | undefined
): ChangeSummary {
  const added = counts?.added ?? 0;
  const removed = counts?.removed ?? 0;
  return {
    path: entry.path,
    ...(entry.oldPath === undefined ? {} : { oldPath: entry.oldPath }),
    status: entry.status,
    added,
    removed,
    ...(counts?.binary === true ? { binary: true } : {}),
    ...(entry.baseSha === undefined ? {} : { baseSha: entry.baseSha }),
    ...(entry.headSha === undefined ? {} : { headSha: entry.headSha }),
    fingerprint: fingerprintOf(cwd, entry, added, removed),
  };
}

async function untrackedSummary(
  cwd: string,
  path: string
): Promise<ChangeSummary> {
  const file = await readUntracked(cwd, path);
  const added = file.binary ? 0 : file.lines;
  return {
    path,
    status: "untracked",
    added,
    removed: 0,
    ...(file.binary ? { binary: true } : {}),
    fingerprint: `${added}:0:${file.mtimeMs}`,
  };
}

function collect(base: DiffBase, files: readonly ChangeSummary[]): ChangeList {
  const kept = files.slice(0, FILE_LIMIT);
  return {
    base,
    files: kept,
    added: kept.reduce((total, file) => total + file.added, 0),
    removed: kept.reduce((total, file) => total + file.removed, 0),
    ...(files.length > kept.length ? { truncated: true } : {}),
  };
}

async function rawEntries(
  cwd: string,
  args: readonly string[]
): Promise<readonly Entry[]> {
  return parseRaw(
    await read(
      cwd,
      ["diff", "--raw", "-z", "--no-abbrev", "--find-renames", ...args],
      "could not read the change list"
    )
  );
}

async function untrackedDiff(
  cwd: string,
  path: string,
  context: number
): Promise<FileDiff> {
  const file = await readUntracked(cwd, path);
  if (file.binary) {
    return { path, hunks: [], binary: true };
  }
  const diff = DiffLines.buildToolDiff(
    path,
    DiffLines.emptySide,
    DiffLines.fromText(file.text),
    context
  );
  return { path, hunks: diff?.hunks ?? [] };
}

/** Every changed file of one base, in git's own order and without a hunk of any of them. */
async function listChanges(
  cwd: string,
  base: DiffBase,
  monitor: GitMonitor
): Promise<ChangeList> {
  return await serialise(monitor, cwd, async () => {
    const args = await baseArgs(cwd, base);
    const [entries, numstat] = await Promise.all([
      rawEntries(cwd, args),
      read(
        cwd,
        ["diff", "--numstat", "-z", "--find-renames", ...args],
        "could not count the changes"
      ),
    ]);
    const counts = parseNumstat(numstat);
    const files = entries.map((entry) =>
      summaryOf(cwd, entry, counts.get(entry.path))
    );
    if (base.kind !== "worktree") {
      return collect(base, files);
    }
    const untracked = await Promise.all(
      (await untrackedPaths(cwd)).map((path) => untrackedSummary(cwd, path))
    );
    return collect(base, [...files, ...untracked]);
  });
}

/** One file's hunks; a renamed file is diffed against the path it came from, an untracked one against nothing. */
async function fileDiff(
  cwd: string,
  base: DiffBase,
  path: string,
  monitor: GitMonitor,
  context: number = DEFAULT_CONTEXT
): Promise<FileDiff> {
  return await serialise(monitor, cwd, async () => {
    const args = await baseArgs(cwd, base);
    const entry = (await rawEntries(cwd, args)).find(
      (candidate) => candidate.path === path
    );
    if (
      entry === undefined &&
      base.kind === "worktree" &&
      (await untrackedPaths(cwd)).includes(path)
    ) {
      return await untrackedDiff(cwd, path, context);
    }
    const paths = entry?.oldPath === undefined ? [path] : [entry.oldPath, path];
    const patch = await read(
      cwd,
      [
        "diff",
        "--no-color",
        `-U${String(context)}`,
        "--find-renames",
        ...args,
        "--",
        ...paths,
      ],
      `could not diff ${path}`
    );
    if (BINARY_PATCH.test(patch)) {
      return { path, hunks: [], binary: true };
    }
    return { path, hunks: DiffPatch.fromUnified(path, patch)?.hunks ?? [] };
  });
}

/**
 * Reading is serialised against the checkouts and pulls that move the tree
 * under it; a read that arrives while one runs is refused rather than answered
 * from half a working tree.
 */
async function serialise<T>(
  monitor: GitMonitor,
  cwd: string,
  work: () => Promise<T>
): Promise<T> {
  let held: { readonly value: T } | undefined;
  const outcome = await monitor.run(cwd, async () => {
    held = { value: await work() };
    return { ok: true };
  });
  if (held === undefined) {
    throw new Error(outcome.ok ? `could not read ${cwd}` : outcome.error);
  }
  return held.value;
}

export const RepoDiff = { listChanges, fileDiff };
