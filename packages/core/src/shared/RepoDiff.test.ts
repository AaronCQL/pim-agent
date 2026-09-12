import { rm, mkdtemp, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, spyOn, test } from "bun:test";

import { git, makeRepo } from "./fixtures/repo";
import { GitMonitor } from "./GitMonitor";
import { Proc } from "./Proc";
import type { ToolDiffHunk } from "./DiffLines";
import { RepoDiff, type ChangeList, type ChangeSummary } from "./RepoDiff";

const monitor = new GitMonitor();

const roots: string[] = [];

afterAll(async () => {
  monitor.dispose();
  await Promise.all(
    roots.map((root) => rm(root, { force: true, recursive: true }))
  );
});

/** A repository with `a.txt` committed, which every test below starts from. */
async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pim-repo-diff-"));
  roots.push(root);
  await makeRepo(root);
  await write(root, "a.txt", "one\ntwo\nthree\n");
  await commit(root, "tracked");
  return root;
}

function write(root: string, path: string, text: string): Promise<number> {
  return Bun.write(join(root, path), text);
}

async function commit(root: string, message: string): Promise<void> {
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", message]);
}

function rowOf(list: ChangeList, path: string): ChangeSummary {
  const row = list.files.find((file) => file.path === path);
  if (row === undefined) {
    throw new Error(
      `${path} is not in the change list: ${list.files.map((file) => file.path).join(", ")}`
    );
  }
  return row;
}

const pathsOf = (list: ChangeList): readonly string[] =>
  list.files.map((file) => file.path);

describe("the five bases", () => {
  /** One tree holding a worktree edit, a staged add and an untracked file at once. */
  async function mixed(): Promise<string> {
    const root = await repo();
    await write(root, "a.txt", "one\ntwo changed\nthree\n");
    await write(root, "staged.txt", "s\n");
    await git(root, ["add", "staged.txt"]);
    await write(root, "loose.txt", "u\n");
    return root;
  }

  test("worktree is everything uncommitted, untracked included", async () => {
    const list = await RepoDiff.listChanges(
      await mixed(),
      { kind: "worktree" },
      monitor
    );

    expect(pathsOf(list)).toEqual(["a.txt", "staged.txt", "loose.txt"]);
    expect(rowOf(list, "a.txt")).toMatchObject({
      status: "modified",
      added: 1,
      removed: 1,
    });
    expect(rowOf(list, "staged.txt").status).toBe("added");
    expect(rowOf(list, "loose.txt")).toMatchObject({
      status: "untracked",
      added: 1,
      removed: 0,
    });
    expect(list).toMatchObject({ added: 3, removed: 1 });
  });

  test("unstaged is the worktree against the index", async () => {
    const list = await RepoDiff.listChanges(
      await mixed(),
      { kind: "unstaged" },
      monitor
    );

    expect(pathsOf(list)).toEqual(["a.txt"]);
  });

  test("staged is the index against HEAD", async () => {
    const list = await RepoDiff.listChanges(
      await mixed(),
      { kind: "staged" },
      monitor
    );

    expect(pathsOf(list)).toEqual(["staged.txt"]);
    expect(rowOf(list, "staged.txt")).toMatchObject({ added: 1, removed: 0 });
  });

  test("commit diffs against the ref it is given", async () => {
    const root = await repo();
    await write(root, "b.txt", "b\n");
    await commit(root, "second");

    const list = await RepoDiff.listChanges(
      root,
      { kind: "commit", ref: "HEAD~1" },
      monitor
    );

    expect(pathsOf(list)).toEqual(["b.txt"]);
    expect(rowOf(list, "b.txt").status).toBe("added");
  });

  test("branch is what this branch added, not what the other one did", async () => {
    const root = await repo();
    await git(root, ["checkout", "-b", "feat/work"]);
    await write(root, "feature.txt", "f\n");
    await commit(root, "feature");
    await git(root, ["checkout", "main"]);
    await write(root, "trunk.txt", "t\n");
    await commit(root, "trunk");
    await git(root, ["checkout", "feat/work"]);

    const branch = await RepoDiff.listChanges(
      root,
      { kind: "branch", ref: "main" },
      monitor
    );
    const commitBase = await RepoDiff.listChanges(
      root,
      { kind: "commit", ref: "main" },
      monitor
    );

    expect(pathsOf(branch)).toEqual(["feature.txt"]);
    expect(pathsOf(commitBase)).toEqual(["feature.txt", "trunk.txt"]);
    expect(rowOf(commitBase, "trunk.txt").status).toBe("deleted");
  });

  test("a ref that does not exist comes back in git's own words", async () => {
    const root = await repo();

    await expect(
      RepoDiff.listChanges(root, { kind: "commit", ref: "nope" }, monitor)
    ).rejects.toThrow(/nope/);
  });
});

describe("the long tail of one file", () => {
  test("a rename is one row carrying the path it came from", async () => {
    const root = await repo();
    await git(root, ["mv", "a.txt", "b.txt"]);
    await write(root, "b.txt", "one\ntwo\nthree\nfour\n");

    const list = await RepoDiff.listChanges(
      root,
      { kind: "worktree" },
      monitor
    );
    const diff = await RepoDiff.fileDiff(
      root,
      { kind: "worktree" },
      "b.txt",
      monitor
    );

    expect(rowOf(list, "b.txt")).toMatchObject({
      status: "renamed",
      oldPath: "a.txt",
      added: 1,
      removed: 0,
    });
    expect(diff.hunks[0]?.lines.map((line) => line.kind)).toEqual([
      "context",
      "context",
      "context",
      "added",
    ]);
  });

  test("an untracked file is counted, and diffed against nothing", async () => {
    const root = await repo();
    await write(root, "fresh.txt", "alpha\nbeta\n");

    const list = await RepoDiff.listChanges(
      root,
      { kind: "worktree" },
      monitor
    );
    const diff = await RepoDiff.fileDiff(
      root,
      { kind: "worktree" },
      "fresh.txt",
      monitor
    );

    expect(rowOf(list, "fresh.txt")).toMatchObject({
      status: "untracked",
      added: 2,
      removed: 0,
      fingerprint: expect.stringMatching(/^2:0:\d+$/),
    });
    expect(diff.hunks[0]?.lines).toEqual([
      { kind: "added", newLine: 1, text: "alpha" },
      { kind: "added", newLine: 2, text: "beta" },
    ]);
  });

  test("a binary file is one row with no counts, tracked or not", async () => {
    const root = await repo();
    await Bun.write(join(root, "tracked.bin"), new Uint8Array([0, 1, 2, 0, 3]));
    await commit(root, "binary");
    await Bun.write(join(root, "tracked.bin"), new Uint8Array([0, 9, 9, 0, 4]));
    await Bun.write(join(root, "loose.bin"), new Uint8Array([7, 0, 7]));

    const list = await RepoDiff.listChanges(
      root,
      { kind: "worktree" },
      monitor
    );
    const diff = await RepoDiff.fileDiff(
      root,
      { kind: "worktree" },
      "tracked.bin",
      monitor
    );
    const loose = await RepoDiff.fileDiff(
      root,
      { kind: "worktree" },
      "loose.bin",
      monitor
    );

    expect(rowOf(list, "tracked.bin")).toMatchObject({
      status: "modified",
      binary: true,
      added: 0,
      removed: 0,
    });
    expect(rowOf(list, "loose.bin")).toMatchObject({
      status: "untracked",
      binary: true,
      added: 0,
    });
    expect(diff).toEqual({
      path: "tracked.bin",
      hunks: [],
      binary: true,
      oldBytes: 5,
      newBytes: 5,
    });
    expect(loose).toEqual({
      path: "loose.bin",
      hunks: [],
      binary: true,
      newBytes: 3,
    });
  });

  test("an untracked file past a megabyte is reported rather than read", async () => {
    const root = await repo();
    await write(root, "huge.txt", "a\n".repeat(600_000));

    const list = await RepoDiff.listChanges(
      root,
      { kind: "worktree" },
      monitor
    );
    const diff = await RepoDiff.fileDiff(
      root,
      { kind: "worktree" },
      "huge.txt",
      monitor
    );

    expect(rowOf(list, "huge.txt")).toMatchObject({ binary: true, added: 0 });
    expect(diff.binary).toBe(true);
  });

  test("a path with a space survives both calls intact", async () => {
    const root = await repo();
    await write(root, "sp ace.txt", "x\n");
    await commit(root, "spaced");
    await write(root, "sp ace.txt", "x\ny\n");

    const list = await RepoDiff.listChanges(
      root,
      { kind: "worktree" },
      monitor
    );
    const diff = await RepoDiff.fileDiff(
      root,
      { kind: "worktree" },
      "sp ace.txt",
      monitor
    );

    expect(rowOf(list, "sp ace.txt")).toMatchObject({ added: 1, removed: 0 });
    expect(diff.hunks[0]?.lines.at(-1)).toMatchObject({
      kind: "added",
      text: "y",
    });
  });

  test("a clean tree is an empty list, not a failure", async () => {
    const list = await RepoDiff.listChanges(
      await repo(),
      { kind: "worktree" },
      monitor
    );

    expect(list).toEqual({
      base: { kind: "worktree" },
      files: [],
      added: 0,
      removed: 0,
    });
  });

  test("a deleted file keeps the sha it was deleted from", async () => {
    const root = await repo();
    await unlink(join(root, "a.txt"));

    const list = await RepoDiff.listChanges(
      root,
      { kind: "worktree" },
      monitor
    );
    const diff = await RepoDiff.fileDiff(
      root,
      { kind: "worktree" },
      "a.txt",
      monitor
    );
    const row = rowOf(list, "a.txt");

    expect(row).toMatchObject({ status: "deleted", added: 0, removed: 3 });
    expect(row.fingerprint).toBe(`deleted:${row.baseSha ?? ""}`);
    expect(row.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(diff.hunks[0]?.lines.every((line) => line.kind === "removed")).toBe(
      true
    );
  });

  test("a detached HEAD is still a diff base", async () => {
    const root = await repo();
    await git(root, ["checkout", "--detach"]);
    await write(root, "a.txt", "one\ntwo\nthree\nfour\n");

    const list = await RepoDiff.listChanges(
      root,
      { kind: "worktree" },
      monitor
    );
    const diff = await RepoDiff.fileDiff(
      root,
      { kind: "worktree" },
      "a.txt",
      monitor
    );

    expect(rowOf(list, "a.txt")).toMatchObject({
      status: "modified",
      added: 1,
      removed: 0,
    });
    expect(diff.hunks[0]?.lines.at(-1)).toMatchObject({
      kind: "added",
      text: "four",
    });
  });

  test("a mode change is a row with no lines in it", async () => {
    const root = await repo();
    await git(root, ["update-index", "--chmod=+x", "a.txt"]);

    const list = await RepoDiff.listChanges(root, { kind: "staged" }, monitor);
    const diff = await RepoDiff.fileDiff(
      root,
      { kind: "staged" },
      "a.txt",
      monitor
    );

    expect(rowOf(list, "a.txt")).toMatchObject({
      status: "modified",
      added: 0,
      removed: 0,
    });
    expect(diff).toEqual({ path: "a.txt", hunks: [], total: 3 });
  });

  test("a symlink diffs as the path it points at", async () => {
    const root = await repo();
    await symlink("a.txt", join(root, "link"));
    await commit(root, "link");
    await unlink(join(root, "link"));
    await symlink("b.txt", join(root, "link"));

    const diff = await RepoDiff.fileDiff(
      root,
      { kind: "worktree" },
      "link",
      monitor
    );

    expect(diff.hunks[0]?.lines).toEqual([
      {
        kind: "removed",
        oldLine: 1,
        text: "a.txt",
        emphasis: [{ start: 0, end: 1 }],
      },
      {
        kind: "added",
        newLine: 1,
        text: "b.txt",
        emphasis: [{ start: 0, end: 1 }],
      },
    ]);
  });

  test("a submodule pointer bump is the two commits it moved between", async () => {
    const root = await repo();
    const first = "1".repeat(40);
    const second = "2".repeat(40);
    await git(root, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${first},sub`,
    ]);
    await git(root, ["commit", "-m", "submodule"]);
    await git(root, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${second},sub`,
    ]);

    const list = await RepoDiff.listChanges(root, { kind: "staged" }, monitor);
    const diff = await RepoDiff.fileDiff(
      root,
      { kind: "staged" },
      "sub",
      monitor
    );

    expect(rowOf(list, "sub")).toMatchObject({ status: "modified" });
    expect(diff.hunks[0]?.lines.map((line) => line.text)).toEqual([
      `Subproject commit ${first}`,
      `Subproject commit ${second}`,
    ]);
  });

  test("an empty file is a row with nothing under it", async () => {
    const root = await repo();
    await write(root, "empty.txt", "");

    const list = await RepoDiff.listChanges(
      root,
      { kind: "worktree" },
      monitor
    );
    const diff = await RepoDiff.fileDiff(
      root,
      { kind: "worktree" },
      "empty.txt",
      monitor
    );

    expect(rowOf(list, "empty.txt")).toMatchObject({
      status: "untracked",
      added: 0,
      removed: 0,
    });
    expect(diff).toEqual({ path: "empty.txt", hunks: [], total: 0 });

    await git(root, ["add", "-A"]);
    const staged = await RepoDiff.listChanges(
      root,
      { kind: "staged" },
      monitor
    );
    const tracked = await RepoDiff.fileDiff(
      root,
      { kind: "staged" },
      "empty.txt",
      monitor
    );

    expect(rowOf(staged, "empty.txt")).toMatchObject({
      status: "added",
      added: 0,
      removed: 0,
    });
    expect(tracked).toEqual({ path: "empty.txt", hunks: [], total: 0 });
  });

  test("a path gitattributes marks -diff is reported as binary", async () => {
    const root = await repo();
    await write(root, ".gitattributes", "secret.txt -diff\n");
    await write(root, "secret.txt", "one\n");
    await commit(root, "attributed");
    await write(root, "secret.txt", "two\n");

    const list = await RepoDiff.listChanges(
      root,
      { kind: "worktree" },
      monitor
    );
    const diff = await RepoDiff.fileDiff(
      root,
      { kind: "worktree" },
      "secret.txt",
      monitor
    );

    expect(rowOf(list, "secret.txt")).toMatchObject({
      binary: true,
      added: 0,
      removed: 0,
    });
    expect(diff).toMatchObject({ binary: true, hunks: [], newBytes: 4 });
  });
});

describe("a file too big to hand over whole", () => {
  const changedOf = (diff: { readonly hunks: readonly ToolDiffHunk[] }) =>
    diff.hunks.reduce(
      (total, hunk) =>
        total + hunk.lines.filter((line) => line.kind !== "context").length,
      0
    );

  test("five thousand new lines come back clipped, not whole", async () => {
    const root = await repo();
    const lines = Array.from({ length: 5000 }, (_, at) => `line ${at}`);
    await write(root, "big.txt", "");
    await commit(root, "empty");
    await write(root, "big.txt", `${lines.join("\n")}\n`);

    const diff = await RepoDiff.fileDiff(
      root,
      { kind: "worktree" },
      "big.txt",
      monitor
    );

    expect(diff.truncated).toBe(true);
    expect(changedOf(diff)).toBe(2000);
    expect(diff.hunks[0]?.lines[0]).toMatchObject({ text: "line 0" });
  });

  test("an untracked file is clipped by the same budget", async () => {
    const root = await repo();
    await write(
      root,
      "fresh.txt",
      `${Array.from({ length: 5000 }, (_, at) => `line ${at}`).join("\n")}\n`
    );

    const diff = await RepoDiff.fileDiff(
      root,
      { kind: "worktree" },
      "fresh.txt",
      monitor
    );

    expect(diff.truncated).toBe(true);
    expect(changedOf(diff)).toBe(2000);
  });

  test("the budget is spent hunk by hunk, and what fits is whole", async () => {
    const root = await repo();
    const block = (mark: string, count: number): string =>
      `${Array.from({ length: count }, (_, at) => `${mark}${at}`).join("\n")}\n`;
    const spacer = block("keep", 20);
    await write(root, "runs.txt", `${spacer}${spacer}${spacer}`);
    await commit(root, "runs");
    await write(
      root,
      "runs.txt",
      `${block("first", 1200)}${spacer}${block("second", 1200)}${spacer}${block("third", 1200)}`
    );

    const diff = await RepoDiff.fileDiff(
      root,
      { kind: "worktree" },
      "runs.txt",
      monitor
    );

    expect(diff.truncated).toBe(true);
    expect(changedOf(diff)).toBe(2000);
    expect(diff.hunks.length).toBe(2);
    expect(diff.hunks[0]?.lines.some((line) => line.text === "first1199")).toBe(
      true
    );
    const cut = diff.hunks[1];
    expect(cut?.newLines).toBe(
      cut?.lines.filter((line) => line.kind !== "removed").length
    );
    expect(cut?.oldLines).toBe(
      cut?.lines.filter((line) => line.kind !== "added").length
    );
  });

  test("a patch past a megabyte is cut at a hunk boundary", async () => {
    const root = await repo();
    const wide = `${"x".repeat(1500)}\n`;
    await write(root, "wide.txt", wide.repeat(400));
    await commit(root, "wide");
    await write(root, "wide.txt", `${"y".repeat(1500)}\n`.repeat(400));

    const diff = await RepoDiff.fileDiff(
      root,
      { kind: "worktree" },
      "wide.txt",
      monitor
    );

    expect(diff.truncated).toBe(true);
    expect(diff.hunks).toEqual([]);
  });
});

describe("fingerprints", () => {
  test("a staged change is fingerprinted by its blob, and a new blob is a new mark", async () => {
    const root = await repo();
    await write(root, "a.txt", "one\ntwo\nthree\nfour\n");
    await git(root, ["add", "-A"]);

    const first = rowOf(
      await RepoDiff.listChanges(root, { kind: "staged" }, monitor),
      "a.txt"
    );
    await write(root, "a.txt", "one\ntwo\nthree\nfive\n");
    await git(root, ["add", "-A"]);
    const second = rowOf(
      await RepoDiff.listChanges(root, { kind: "staged" }, monitor),
      "a.txt"
    );

    expect(first.fingerprint).toBe(first.headSha ?? "");
    expect(first.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  test("a file only the worktree has is fingerprinted by its counts and mtime", async () => {
    const root = await repo();
    await write(root, "a.txt", "one\ntwo\nthree\nfour\n");

    const row = rowOf(
      await RepoDiff.listChanges(root, { kind: "worktree" }, monitor),
      "a.txt"
    );

    expect(row.headSha).toBeUndefined();
    expect(row.fingerprint).toMatch(/^1:0:\d+$/);
  });
});

describe("the calls themselves", () => {
  test("every git call refuses the optional lock, and every enumeration is NUL-separated", async () => {
    const root = await repo();
    await write(root, "a.txt", "one\ntwo\nfour\n");
    await write(root, "loose.txt", "u\n");
    const calls: (readonly string[])[] = [];
    const run = Proc.run;
    const spy = spyOn(Proc, "run").mockImplementation((cmd, options) => {
      calls.push([...cmd]);
      return run(cmd, options);
    });

    try {
      await RepoDiff.listChanges(root, { kind: "worktree" }, monitor);
      await RepoDiff.fileDiff(root, { kind: "worktree" }, "a.txt", monitor);
    } finally {
      spy.mockRestore();
    }

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call[0]).toBe("git");
      expect(call).toContain("--no-optional-locks");
    }
    const enumerations = calls.filter((call) =>
      call.some((arg) => arg === "--raw" || arg === "--numstat")
    );
    expect(enumerations.length).toBe(3);
    for (const call of enumerations) {
      expect(call).toContain("-z");
    }
  });

  test("a read arriving under an operation is refused, and answers once it ends", async () => {
    const root = await repo();
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = monitor.run(root, async () => {
      await held;
      return { ok: true };
    });

    await expect(
      RepoDiff.listChanges(root, { kind: "worktree" }, monitor)
    ).rejects.toThrow(/already running/);
    release();
    await operation;

    expect(
      (await RepoDiff.listChanges(root, { kind: "worktree" }, monitor)).files
    ).toEqual([]);
  });
});

describe("the lines behind a gap", () => {
  /** A file long enough that a diff of it leaves gaps to open. */
  function long(): string {
    return `${Array.from({ length: 60 }, (_, at) => `line ${at + 1}`).join("\n")}\n`;
  }

  test("a span comes back whole, 1-based and inclusive", async () => {
    const root = await repo();
    await write(root, "long.txt", long());
    await commit(root, "long");
    await write(root, "long.txt", long().replace("line 1\n", "LINE 1\n"));

    const read = await RepoDiff.readLines(
      root,
      { kind: "worktree" },
      "long.txt",
      [
        { start: 10, end: 12 },
        { start: 20, end: 20 },
      ],
      monitor
    );

    expect(read).toEqual({
      path: "long.txt",
      runs: [
        { start: 10, lines: ["line 10", "line 11", "line 12"] },
        { start: 20, lines: ["line 20"] },
      ],
    });
  });

  test("a span running past either end of the file is clamped to it", async () => {
    const root = await repo();

    const read = await RepoDiff.readLines(
      root,
      { kind: "worktree" },
      "a.txt",
      [
        { start: 0, end: 2 },
        { start: 40, end: 80 },
      ],
      monitor
    );

    expect(read.runs).toEqual([{ start: 1, lines: ["one", "two"] }]);
  });

  test("a staged base reads the index, not the working tree beside it", async () => {
    const root = await repo();
    await write(root, "a.txt", "one\nstaged\nthree\n");
    await git(root, ["add", "-A"]);
    await write(root, "a.txt", "one\nworktree\nthree\n");

    const read = await RepoDiff.readLines(
      root,
      { kind: "staged" },
      "a.txt",
      [{ start: 2, end: 2 }],
      monitor
    );

    expect(read.runs).toEqual([{ start: 2, lines: ["staged"] }]);
  });

  test("an untracked file is read as it lies", async () => {
    const root = await repo();
    await write(root, "loose.txt", "fresh\nink\n");

    const read = await RepoDiff.readLines(
      root,
      { kind: "worktree" },
      "loose.txt",
      [{ start: 2, end: 2 }],
      monitor
    );

    expect(read.runs).toEqual([{ start: 2, lines: ["ink"] }]);
  });

  test("a file with no side to read says so", async () => {
    const root = await repo();

    await expect(
      RepoDiff.readLines(
        root,
        { kind: "worktree" },
        "gone.txt",
        [{ start: 1, end: 1 }],
        monitor
      )
    ).rejects.toThrow(/could not read gone.txt/);
  });

  test("a clipped diff says nothing about where the file ends", async () => {
    const root = await repo();
    const lines = Array.from({ length: 5000 }, (_, at) => `line ${at + 1}`);
    await write(root, "huge.txt", `${lines.join("\n")}\n`);

    const diff = await RepoDiff.fileDiff(
      root,
      { kind: "worktree" },
      "huge.txt",
      monitor
    );

    expect(diff.truncated).toBe(true);
    expect(diff.total).toBeUndefined();
  });

  test("a diff carries the file's length, so a reader knows where it ends", async () => {
    const root = await repo();
    await write(root, "long.txt", long());
    await commit(root, "long");
    await write(root, "long.txt", long().replace("line 1\n", "LINE 1\n"));

    const diff = await RepoDiff.fileDiff(
      root,
      { kind: "worktree" },
      "long.txt",
      monitor
    );

    expect(diff.total).toBe(60);
    expect(diff.hunks).toHaveLength(1);
  });
});
