import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { git, makeRepo } from "./fixtures/repo";
import { Git, type GitOutcome } from "./Git";

/** Narrowing an outcome in an assertion: `ok` is the discriminant, not a flag. */
const refusal = (outcome: GitOutcome): string =>
  outcome.ok ? "" : outcome.error;

const tempRoots: string[] = [];

const tempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "pim-footer-git-"));
  tempRoots.push(root);
  return root;
};

afterAll(async () => {
  await Promise.all(
    tempRoots.map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("parseGitStatus", () => {
  test("parses clean branch status", () => {
    expect(
      Git.parseStatus(
        [
          "# branch.oid 123456",
          "# branch.head main",
          "# branch.upstream origin/main",
          "# branch.ab +0 -0",
        ].join("\n")
      )
    ).toEqual({
      branch: "main",
      dirtyCount: 0,
      ahead: 0,
      behind: 0,
    });
  });

  test("counts one dirty path per entry, tracked or not", () => {
    expect(
      Git.parseStatus(
        [
          "# branch.oid 123456",
          "# branch.head feature/footer",
          "# branch.upstream origin/feature/footer",
          "# branch.ab +12 -3",
          "1 .M N... 100644 100644 100644 abc abc src/file.ts",
          "? scratch.txt",
        ].join("\n")
      )
    ).toEqual({
      branch: "feature/footer",
      dirtyCount: 2,
      ahead: 12,
      behind: 3,
    });
  });

  test("labels detached heads explicitly", () => {
    expect(Git.parseStatus("# branch.head (detached)\n")).toEqual({
      branch: "detached",
      dirtyCount: 0,
      ahead: 0,
      behind: 0,
    });
  });
});

describe("fetchGitStatus", () => {
  test("returns empty git state outside a git repository", async () => {
    const root = await tempRoot();

    expect(await Git.fetchStatus(root)).toEqual(Git.EMPTY);
  });
});

describe("parseRefs", () => {
  test("reads the counts, the current branch and the one held elsewhere", () => {
    expect(
      Git.parseRefs(
        [
          "main\u00001700000000\u0000\u0000\u0000*",
          "feat/a\u00001600000000\u0000[ahead 2, behind 1]\u0000\u0000 ",
          "feat/b\u00001500000000\u0000[gone]\u0000/tmp/other\u0000 ",
        ].join("\n")
      )
    ).toEqual([
      {
        name: "main",
        current: true,
        updatedAt: 1700000000,
        ahead: 0,
        behind: 0,
        gone: false,
        worktree: false,
      },
      {
        name: "feat/a",
        current: false,
        updatedAt: 1600000000,
        ahead: 2,
        behind: 1,
        gone: false,
        worktree: false,
      },
      {
        name: "feat/b",
        current: false,
        updatedAt: 1500000000,
        ahead: 0,
        behind: 0,
        gone: true,
        worktree: true,
      },
    ]);
  });
});

describe("parseVisits", () => {
  test("keeps the newest checkout of each branch, both sides of the move", () => {
    const visits = Git.parseVisits(
      [
        "HEAD@{300}\u0000checkout: moving from feat/a to main",
        "HEAD@{200}\u0000checkout: moving from feat/b to feat/a",
        "HEAD@{100}\u0000commit: something else entirely",
      ].join("\n")
    );

    expect(visits.get("main")).toBe(300);
    expect(visits.get("feat/a")).toBe(300);
    expect(visits.get("feat/b")).toBe(200);
    expect(visits.size).toBe(3);
  });
});

async function repo(): Promise<string> {
  const root = await tempRoot();
  await makeRepo(root, ["feat/work"]);
  await Bun.write(join(root, "file.txt"), "one\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "tracked"]);
  return root;
}

describe("listBranches", () => {
  test("puts the trunk first and marks what is merged into it", async () => {
    const root = await repo();

    const branches = await Git.listBranches(root);

    expect(branches.map((branch) => branch.name)).toEqual([
      "main",
      "feat/work",
    ]);
    expect(branches[0]).toMatchObject({ isDefault: true, merged: true });
    expect(branches[1]).toMatchObject({
      isDefault: false,
      current: true,
      merged: false,
      gone: false,
      worktree: false,
    });
  });

  test("answers nothing outside a repository", async () => {
    expect(await Git.listBranches(await tempRoot())).toEqual([]);
  });
});

describe("checkout", () => {
  test("switches branches, and says why when it cannot", async () => {
    const root = await repo();

    expect(await Git.checkout(root, "main")).toEqual({ ok: true });
    expect((await Git.fetchStatus(root)).branch).toBe("main");

    expect(refusal(await Git.checkout(root, "nope"))).toContain("nope");
  });

  test("refuses rather than clobbering work in the tree", async () => {
    const root = await repo();
    await Bun.write(join(root, "file.txt"), "uncommitted\n");

    expect(refusal(await Git.checkout(root, "main"))).toContain(
      "would be overwritten"
    );
  });
});

describe("push", () => {
  test("names the missing remote instead of hanging on one", async () => {
    expect(refusal(await Git.push(await repo()))).toContain("no remote");
  });
});
