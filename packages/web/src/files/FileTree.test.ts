import { expect, test } from "bun:test";

import { FileTree, type TreeNode } from "./FileTree";

function shape(node: TreeNode): unknown {
  return node.children === undefined
    ? node.name
    : { [node.name]: node.children.map(shape) };
}

test("build puts folders before files and sorts each level by name", () => {
  const root = FileTree.build([
    "b.ts",
    "src/z.ts",
    "A.md",
    "src/a.ts",
    "lib/x",
  ]);

  expect(shape(root)).toEqual({
    "": [{ lib: ["x"] }, { src: ["a.ts", "z.ts"] }, "A.md", "b.ts"],
  });
});

test("build folds a chain of single-folder folders into one row", () => {
  const root = FileTree.build([
    "packages/web/src/App.tsx",
    "packages/web/src/ui/Menu.tsx",
  ]);

  const [folded] = root.children ?? [];

  expect(folded).toMatchObject({
    name: "packages/web/src",
    path: "packages/web/src",
  });
  expect(shape(root)).toEqual({
    "": [{ "packages/web/src": [{ ui: ["Menu.tsx"] }, "App.tsx"] }],
  });
});

test("rows descend only into open folders", () => {
  const root = FileTree.build(["src/a/one.ts", "src/b.ts", "top.ts"]);
  const open = new Set(["src"]);

  const rows = FileTree.rows(root, (path) => open.has(path));

  expect(rows.map((row) => [row.node.path, row.depth])).toEqual([
    ["src", 0],
    ["src/a", 1],
    ["src/b.ts", 1],
    ["top.ts", 0],
  ]);
});

test("ancestors lists every folder above a path", () => {
  expect(FileTree.ancestors("a/b/c.ts")).toEqual(["a", "a/b"]);
  expect(FileTree.ancestors("c.ts")).toEqual([]);
});

test("match wants every word and ranks name hits over folder hits", () => {
  const paths = ["menu/index.ts", "src/ui/Menu.tsx", "src/ui/Modal.tsx"];

  expect(FileTree.match(paths, "menu")).toEqual([
    "src/ui/Menu.tsx",
    "menu/index.ts",
  ]);
  expect(FileTree.match(paths, "ui mod")).toEqual(["src/ui/Modal.tsx"]);
  expect(FileTree.match(paths, "  ")).toEqual([]);
});
