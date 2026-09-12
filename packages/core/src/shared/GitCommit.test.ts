import { chmod, mkdtemp, rename, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";

import { git, makeRepo } from "./fixtures/repo";
import { Git, type CommitResult } from "./Git";
import { Proc } from "./Proc";

/**
 * What `Git.commit` puts in a commit, and what it refuses to. Every assertion
 * here is git's own answer over a real repository: a path-limited commit is
 * only worth anything if what it leaves behind is exactly what it found.
 */

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { force: true, recursive: true }))
  );
});

async function read(root: string, args: readonly string[]): Promise<string> {
  const { stdout } = await Proc.run(["git", ...args], { cwd: root });
  return stdout.trim();
}

const head = (root: string): Promise<string> =>
  read(root, ["rev-parse", "HEAD"]);

const status = (root: string): Promise<string> =>
  read(root, ["status", "--porcelain"]);

const landed = (root: string): Promise<string> =>
  read(root, ["show", "--name-status", "--format=", "HEAD"]);

const stagedPaths = (root: string): Promise<string> =>
  read(root, ["diff", "--cached", "--name-only"]);

const tracked = (root: string): Promise<string> => read(root, ["ls-files"]);

const refusal = (result: CommitResult): string =>
  result.ok ? "" : result.error;

const landedSha = (result: CommitResult): string =>
  result.ok ? result.sha : "";

/** A repository with three committed files, and an identity of its own so no machine's config decides the test. */
async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pim-git-commit-"));
  roots.push(root);
  await makeRepo(root);
  await git(root, ["config", "user.email", "pim@example.com"]);
  await git(root, ["config", "user.name", "pim"]);
  await Bun.write(join(root, "a.txt"), "a\n");
  await Bun.write(join(root, "b.txt"), "b\n");
  await Bun.write(join(root, "sp ace.txt"), "space\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "base"]);
  return root;
}

test("commits the picked paths and leaves every other change dirty", async () => {
  const root = await repo();
  await Bun.write(join(root, "a.txt"), "picked\n");
  await Bun.write(join(root, "b.txt"), "left alone\n");

  const result = await Git.commit(root, {
    message: "just a",
    paths: ["a.txt"],
  });

  expect(result.ok).toBe(true);
  expect(landedSha(result)).toBe(
    await read(root, ["rev-parse", "--short", "HEAD"])
  );
  expect(await landed(root)).toBe("M\ta.txt");
  expect(await status(root)).toBe("M b.txt");
});

test("an untracked picked file is added before it is committed", async () => {
  const root = await repo();
  await Bun.write(join(root, "fresh.txt"), "new\n");

  const result = await Git.commit(root, {
    message: "add fresh",
    paths: ["fresh.txt"],
  });

  expect(result.ok).toBe(true);
  expect(await landed(root)).toBe("A\tfresh.txt");
  expect(await status(root)).toBe("");
});

test("a deleted picked file commits its deletion", async () => {
  const root = await repo();
  await unlink(join(root, "a.txt"));

  const result = await Git.commit(root, {
    message: "drop a",
    paths: ["a.txt"],
  });

  expect(result.ok).toBe(true);
  expect(await landed(root)).toBe("D\ta.txt");
  expect(await status(root)).toBe("");
});

test("a path with a space in it is one path, not two", async () => {
  const root = await repo();
  await Bun.write(join(root, "sp ace.txt"), "edited\n");

  const result = await Git.commit(root, {
    message: "space",
    paths: ["sp ace.txt"],
  });

  expect(result.ok).toBe(true);
  expect(await landed(root)).toBe("M\tsp ace.txt");
  expect(await status(root)).toBe("");
});

test("a rename committed by both of its names leaves nothing behind", async () => {
  const root = await repo();
  await rename(join(root, "a.txt"), join(root, "moved.txt"));

  const result = await Git.commit(root, {
    message: "move a",
    paths: ["moved.txt", "a.txt"],
  });

  expect(result.ok).toBe(true);
  expect((await tracked(root)).split("\n")).toEqual([
    "b.txt",
    "moved.txt",
    "sp ace.txt",
  ]);
  expect(await status(root)).toBe("");
});

test("a path someone else had staged is still staged afterwards", async () => {
  const root = await repo();
  await Bun.write(join(root, "b.txt"), "staged by hand\n");
  await git(root, ["add", "b.txt"]);
  await Bun.write(join(root, "a.txt"), "picked\n");

  const result = await Git.commit(root, {
    message: "just a",
    paths: ["a.txt"],
  });

  expect(result.ok).toBe(true);
  expect(await landed(root)).toBe("M\ta.txt");
  expect(await stagedPaths(root)).toBe("b.txt");
});

test("an empty message is refused before anything is written", async () => {
  const root = await repo();
  await Bun.write(join(root, "a.txt"), "picked\n");
  const before = await head(root);

  const result = await Git.commit(root, { message: "  \n ", paths: ["a.txt"] });

  expect(refusal(result)).toContain("message");
  expect(await head(root)).toBe(before);
  expect(await stagedPaths(root)).toBe("");
});

test("an empty path list is refused", async () => {
  const root = await repo();
  const before = await head(root);

  const result = await Git.commit(root, { message: "nothing", paths: [] });

  expect(refusal(result)).toContain("nothing");
  expect(await head(root)).toBe(before);
});

test("a path outside the repository is refused, absolute or climbing", async () => {
  const root = await repo();
  await Bun.write(join(root, "a.txt"), "picked\n");
  const before = await head(root);

  expect(
    refusal(
      await Git.commit(root, { message: "escape", paths: ["/etc/passwd"] })
    )
  ).toContain("/etc/passwd");
  expect(
    refusal(
      await Git.commit(root, { message: "escape", paths: ["../outside.txt"] })
    )
  ).toContain("../outside.txt");
  expect(
    refusal(
      await Git.commit(root, {
        message: "escape",
        paths: ["src/../../out.txt"],
      })
    )
  ).toContain("out.txt");

  expect(await head(root)).toBe(before);
  expect(await stagedPaths(root)).toBe("");
});

test("a pre-commit hook that fails says what it said and commits nothing", async () => {
  const root = await repo();
  const hook = join(root, ".git", "hooks", "pre-commit");
  await Bun.write(hook, "#!/bin/sh\necho 'lint is angry'\nexit 1\n");
  await chmod(hook, 0o755);
  await Bun.write(join(root, "a.txt"), "picked\n");
  const before = await head(root);

  const result = await Git.commit(root, {
    message: "hooked",
    paths: ["a.txt"],
  });

  expect(refusal(result)).toContain("lint is angry");
  expect(await head(root)).toBe(before);
});
