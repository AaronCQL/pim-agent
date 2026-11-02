import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { FileEnumerator } from "./FileEnumerator";
import { RepoFiles } from "./RepoFiles";

let tmp: string;
let cwd: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pim-repo-files-"));
  cwd = join(tmp, "work");
  await mkdir(join(cwd, ".git"), { recursive: true });
  await Bun.write(join(cwd, ".gitignore"), "dist/\n");
  await Bun.write(join(cwd, "src/b.ts"), "export const b = 1;\n");
  await Bun.write(join(cwd, "a.md"), "# a\n");
  await Bun.write(join(cwd, ".github/ci.yml"), "on: push\n");
  await Bun.write(join(cwd, "dist/out.js"), "built\n");
  await Bun.write(join(tmp, "secret.txt"), "outside\n");
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

test("list answers every file sorted, dotfiles in and ignored files out", async () => {
  expect(await RepoFiles.list(cwd)).toEqual({
    paths: [".github/ci.yml", ".gitignore", "a.md", "src/b.ts"],
  });
});

test("the enumerator stops walking near its limit", async () => {
  for (let index = 0; index < 50; index += 1) {
    await Bun.write(join(cwd, `many/${String(index)}/f.txt`), "");
  }

  const paths = await FileEnumerator.enumerate(cwd, { limit: 5 });

  expect(paths.length).toBeLessThan(40);
});

test("read answers a text file with a fingerprint of its content", async () => {
  const file = await RepoFiles.read(cwd, "src/b.ts");

  expect(file).toMatchObject({
    path: "src/b.ts",
    bytes: 20,
    text: "export const b = 1;\n",
  });
  await Bun.write(join(cwd, "src/b.ts"), "export const b = 22;\n");
  expect((await RepoFiles.read(cwd, "src/b.ts")).fingerprint).not.toBe(
    file.fingerprint
  );
});

test("read withholds the text of a binary file", async () => {
  await Bun.write(join(cwd, "blob.bin"), new Uint8Array([1, 0, 2]));

  expect(await RepoFiles.read(cwd, "blob.bin")).toMatchObject({
    bytes: 3,
    binary: true,
  });
  expect((await RepoFiles.read(cwd, "blob.bin")).text).toBeUndefined();
});

test("read withholds the text of a file too large to show", async () => {
  await Bun.write(
    join(cwd, "huge.txt"),
    "x".repeat(RepoFiles.READ_BYTE_LIMIT + 1)
  );

  const file = await RepoFiles.read(cwd, "huge.txt");

  expect(file.text).toBeUndefined();
  expect(file.binary).toBeUndefined();
});

test("read refuses paths that leave the working directory", async () => {
  await symlink(join(tmp, "secret.txt"), join(cwd, "link.txt"));

  expect(RepoFiles.read(cwd, "../secret.txt")).rejects.toThrow("outside");
  expect(RepoFiles.read(cwd, "link.txt")).rejects.toThrow("outside");
  expect(RepoFiles.read(cwd, join(tmp, "secret.txt"))).rejects.toThrow(
    "outside"
  );
});

test("read refuses a directory and a missing file", async () => {
  expect(RepoFiles.read(cwd, "src")).rejects.toThrow("not a file");
  expect(RepoFiles.read(cwd, "nope.ts")).rejects.toThrow("does not exist");
});
