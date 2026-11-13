import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { FileEnumerator } from "./FileEnumerator";
import { useXdgConfigHome } from "./fixtures/home";
import { type FolderEntry, RepoFiles } from "./RepoFiles";

useXdgConfigHome("pim-repo-files-xdg-");

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

const folderOf = (name: string, path = name): FolderEntry => ({
  name,
  path,
  kind: "folder",
});
const fileOf = (name: string, path = name): FolderEntry => ({
  name,
  path,
  kind: "file",
});

test("folder answers the root's entries, dotfiles in and ignored ones out", async () => {
  expect(await RepoFiles.folder(cwd, "")).toEqual({
    path: "",
    entries: [
      folderOf(".github"),
      folderOf("src"),
      fileOf(".gitignore"),
      fileOf("a.md"),
    ],
  });
});

test("folder enters an ignored nested repo, which keeps its own rules", async () => {
  await Bun.write(join(cwd, ".gitignore"), "lib/\n*.tmp\n");
  await mkdir(join(cwd, "lib/.git"), { recursive: true });
  await Bun.write(join(cwd, "lib/.gitignore"), "*.log\n");
  await Bun.write(join(cwd, "lib/keep.tmp"), "");
  await Bun.write(join(cwd, "lib/drop.log"), "");
  await Bun.write(join(cwd, "lib/src/x.ts"), "");
  await Bun.write(join(cwd, "root.tmp"), "");

  const root = await RepoFiles.folder(cwd, "");
  const lib = await RepoFiles.folder(cwd, "lib");

  expect(root.entries.map((entry) => entry.path)).toEqual([
    ".github",
    "dist",
    "lib",
    "src",
    ".gitignore",
    "a.md",
  ]);
  expect(lib.entries).toEqual([
    folderOf("src", "lib/src"),
    fileOf(".gitignore", "lib/.gitignore"),
    fileOf("keep.tmp", "lib/keep.tmp"),
  ]);
});

test("folder folds a chain of single-folder folders, but never the one listed", async () => {
  await Bun.write(join(cwd, "deep/a/b/c/f.ts"), "");
  await mkdir(join(cwd, "solo/empty"), { recursive: true });
  await Bun.write(join(cwd, "pkg/dist/out.js"), "");
  await Bun.write(join(cwd, "pkg/lib/x.ts"), "");

  const root = await RepoFiles.folder(cwd, "");

  expect(root.entries.filter((entry) => entry.kind === "folder")).toEqual([
    folderOf(".github"),
    folderOf("deep/a/b/c", "deep/a/b/c"),
    folderOf("pkg/lib", "pkg/lib"),
    folderOf("solo/empty", "solo/empty"),
    folderOf("src"),
  ]);
  expect((await RepoFiles.folder(cwd, "deep")).entries).toEqual([
    folderOf("a/b/c", "deep/a/b/c"),
  ]);
  expect((await RepoFiles.folder(cwd, "solo/empty")).entries).toEqual([]);
});

test("folder orders folders, then files, each by name regardless of case", async () => {
  for (const file of ["m/b.md", "m/A.md", "m/C.md", "m/Zed/z", "m/alpha/a"]) {
    await Bun.write(join(cwd, file), "");
  }

  const { entries } = await RepoFiles.folder(cwd, "m");

  expect(entries.map((entry) => entry.name)).toEqual([
    "alpha",
    "Zed",
    "A.md",
    "b.md",
    "C.md",
  ]);
});

test("folder caps its entries and says so", async () => {
  await mkdir(join(cwd, "many"));
  await Promise.all(
    Array.from({ length: RepoFiles.FOLDER_LIMIT + 1 }, (_, index) =>
      Bun.write(join(cwd, `many/${String(index)}`), "")
    )
  );

  const listing = await RepoFiles.folder(cwd, "many");

  expect(listing.entries).toHaveLength(RepoFiles.FOLDER_LIMIT);
  expect(listing.truncated).toBe(true);
});

test("folder refuses paths that leave the cwd, files, and missing or ignored folders", async () => {
  await mkdir(join(tmp, "elsewhere"));
  await symlink(join(tmp, "elsewhere"), join(cwd, "out"));

  expect(RepoFiles.folder(cwd, "..")).rejects.toThrow("outside");
  expect(RepoFiles.folder(cwd, "out")).rejects.toThrow("outside");
  expect(RepoFiles.folder(cwd, "a.md")).rejects.toThrow("not a folder");
  expect(RepoFiles.folder(cwd, "nope")).rejects.toThrow("does not exist");
  expect(RepoFiles.folder(cwd, "dist")).rejects.toThrow("ignored");
});

test("match wants every word, and puts paths whose name holds one first", () => {
  const paths = ["src/view/a.ts", "lib/view.ts", "view/src/b.ts", "x.md"];

  expect(RepoFiles.match(paths, "  VIEW  ")).toEqual([
    "lib/view.ts",
    "src/view/a.ts",
    "view/src/b.ts",
  ]);
  expect(RepoFiles.match(paths, "src b")).toEqual(["view/src/b.ts"]);
  expect(RepoFiles.match(paths, " ")).toEqual([]);
});

test("match stops at its limit", () => {
  const paths = Array.from({ length: 300 }, (_, index) => `d/${String(index)}`);

  expect(RepoFiles.match(paths, "d")).toHaveLength(RepoFiles.MATCH_LIMIT);
});

test("find searches the files the folders show", async () => {
  await Bun.write(join(cwd, ".gitignore"), "lib/\ndist/\n");
  await mkdir(join(cwd, "lib/.git"), { recursive: true });
  await Bun.write(join(cwd, "lib/b.ts"), "");

  expect(await RepoFiles.find(cwd, "b")).toEqual({
    paths: ["lib/b.ts", "src/b.ts", ".github/ci.yml"],
  });
  expect(await RepoFiles.find(cwd, "out")).toEqual({ paths: [] });
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
