import { expect, test } from "bun:test";

import type { FolderEntry } from "#protocol/Diff";
import { type Folder, FileTree, type TreeRow } from "./FileTree";

function folder(name: string, path = name): FolderEntry {
  return { name, path, kind: "folder" };
}

function file(path: string): FolderEntry {
  return { name: path.slice(path.lastIndexOf("/") + 1), path, kind: "file" };
}

function ready(
  path: string,
  entries: readonly FolderEntry[],
  truncated?: true
): Folder {
  return { kind: "ready", value: { path, entries, truncated } };
}

function shape(row: TreeRow): readonly [string, number] {
  return [
    row.kind === "entry" ? row.entry.path : row.failed ? "failed" : "truncated",
    row.depth,
  ];
}

test("rows descend only into open folders that have a listing", () => {
  const folders: Record<string, Folder> = {
    "": ready("", [folder("src"), folder("lib"), file("top.ts")]),
    src: ready("src", [folder("a", "src/a"), file("src/b.ts")]),
    "src/a": ready("src/a", [file("src/a/one.ts")]),
    lib: { kind: "loading" },
  };
  const open = new Set(["src", "lib"]);

  const rows = FileTree.rows(folders, (path) => open.has(path));

  expect(rows.map(shape)).toEqual([
    ["src", 0],
    ["src/a", 1],
    ["src/b.ts", 1],
    ["lib", 0],
    ["top.ts", 0],
  ]);
});

test("rows follow a folded folder by its deepest path", () => {
  const folders: Record<string, Folder> = {
    "": ready("", [folder("web/src", "packages/web/src")]),
    "packages/web/src": ready("packages/web/src", [
      file("packages/web/src/App.tsx"),
    ]),
  };

  const rows = FileTree.rows(folders, () => true);

  expect(rows.map(shape)).toEqual([
    ["packages/web/src", 0],
    ["packages/web/src/App.tsx", 1],
  ]);
});

test("rows close a truncated folder with a note and stand a failed one in for its entries", () => {
  const folders: Record<string, Folder> = {
    "": ready("", [folder("big"), folder("gone")], true),
    big: ready("big", [file("big/a.ts")], true),
    gone: { kind: "error", message: "gone is not a folder" },
  };

  const rows = FileTree.rows(folders, () => true);

  expect(rows.map(shape)).toEqual([
    ["big", 0],
    ["big/a.ts", 1],
    ["truncated", 1],
    ["gone", 0],
    ["failed", 1],
    ["truncated", 0],
  ]);
  expect(rows[4]).toMatchObject({
    folder: "gone",
    text: "gone is not a folder",
  });
});

test("hits lead each path with the folders above it", () => {
  expect(FileTree.hits(["src/a.ts", "top.ts"])).toEqual([
    {
      kind: "entry",
      entry: { name: "a.ts", path: "src/a.ts", kind: "file" },
      depth: 0,
      lead: "src/",
    },
    {
      kind: "entry",
      entry: { name: "top.ts", path: "top.ts", kind: "file" },
      depth: 0,
      lead: "",
    },
  ]);
});

test("ancestors lists every folder above a path", () => {
  expect(FileTree.ancestors("a/b/c.ts")).toEqual(["a", "a/b"]);
  expect(FileTree.ancestors("c.ts")).toEqual([]);
});
