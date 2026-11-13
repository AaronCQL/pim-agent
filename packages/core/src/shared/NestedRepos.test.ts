import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { NestedRepos } from "./NestedRepos";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "pim-nested-repos-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function repo(path: string): Promise<void> {
  await mkdir(join(cwd, path, ".git"), { recursive: true });
  await Bun.write(join(cwd, path, "README.md"), "# repo\n");
}

test("finds a repository the outer one ignores, but not one inside an ignored plain directory", async () => {
  await repo("");
  await Bun.write(join(cwd, ".git/info/exclude"), "excluded/\n");
  await Bun.write(join(cwd, ".gitignore"), "node_modules/\n");
  await repo("excluded");
  await repo("node_modules/dep");
  await repo("packages/tracked");

  expect(await NestedRepos.find(cwd)).toEqual(["excluded", "packages/tracked"]);
});

test("finds repositories under a directory that is no repository itself", async () => {
  await repo("b");
  await repo("a");
  await repo("a/vendor/lib");
  await Bun.write(join(cwd, "notes/todo.md"), "- one\n");

  expect(await NestedRepos.find(cwd)).toEqual(["a", "a/vendor/lib", "b"]);
});

test("a .git file marks a submodule or worktree root", async () => {
  await repo("");
  await Bun.write(join(cwd, "sub/.git"), "gitdir: ../.git/modules/sub\n");
  await Bun.write(join(cwd, "sub/main.c"), "int main;\n");

  expect(await NestedRepos.find(cwd)).toEqual(["sub"]);
});

test("finds a freshly initialised repository with no files yet", async () => {
  await mkdir(join(cwd, "fresh/.git"), { recursive: true });

  expect(await NestedRepos.find(cwd)).toEqual(["fresh"]);
});

test("the ignore rules of a found repository still apply below it", async () => {
  await repo("inner");
  await Bun.write(join(cwd, "inner/.gitignore"), "build/\n");
  await repo("inner/build/cache");

  expect(await NestedRepos.find(cwd)).toEqual(["inner"]);
});

test("verify takes a repository root inside the cwd, a .git file included", async () => {
  await repo("a/lib");
  await Bun.write(join(cwd, "sub/.git"), "gitdir: ../.git/modules/sub\n");

  await NestedRepos.verify(cwd, "a/lib");
  await NestedRepos.verify(cwd, "sub");
});

test("verify refuses a path that is not plain, leaves the cwd, or is no repository", async () => {
  const outside = await mkdtemp(join(tmpdir(), "pim-nested-outside-"));
  try {
    await mkdir(join(outside, ".git"));
    await repo("inner");
    await mkdir(join(cwd, "plain"));
    await symlink(outside, join(cwd, "out"));
    await symlink(".", join(cwd, "self"));

    for (const path of [
      "",
      ".",
      "..",
      "./inner",
      "inner/",
      "inner/.",
      "plain/../inner",
      join(cwd, "inner"),
      "out",
      "self",
      "plain",
      "missing",
    ]) {
      await expect(NestedRepos.verify(cwd, path)).rejects.toThrow();
    }
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
