import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { GitignoreFilter } from "./GitignoreFilter";

const tempRoots: string[] = [];

const createTempDir = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "pim-gitignore-filter-"));
  tempRoots.push(root);
  return root;
};

afterAll(async () => {
  await Promise.all(
    tempRoots.map((root) => rm(root, { force: true, recursive: true }))
  );
});

test("applies hardcoded defaults", async () => {
  const root = await createTempDir();
  const filter = await GitignoreFilter.for(root);

  expect(filter.ignores(join(root, "node_modules", "pkg", "index.js"))).toBe(
    true
  );
  expect(filter.ignores(join(root, ".git", "config"))).toBe(true);
  expect(filter.ignores(join(root, "src", "index.ts"))).toBe(false);
});

test("loads gitignore patterns from root up to the git boundary", async () => {
  const root = await createTempDir();
  const project = join(root, "project");
  const nested = join(project, "packages", "app");

  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(nested, { recursive: true });
  await writeFile(
    join(project, ".gitignore"),
    ["*.tmp", "*.log", "!important.log", "logs/", "/anchored.txt"].join("\n"),
    "utf8"
  );
  await writeFile(join(nested, ".gitignore"), "local.txt\n", "utf8");

  const filter = await GitignoreFilter.for(nested);

  expect(filter.ignores(join(nested, "scratch.tmp"))).toBe(true);
  expect(filter.ignores(join(nested, "logs", "app.log"))).toBe(true);
  expect(filter.ignores(join(project, "anchored.txt"))).toBe(true);
  expect(filter.ignores(join(nested, "anchored.txt"))).toBe(false);
  expect(filter.ignores(join(nested, "drop.log"))).toBe(true);
  expect(filter.ignores(join(nested, "important.log"))).toBe(false);
  expect(filter.ignores(join(nested, "local.txt"))).toBe(true);
});

test("rejects relative paths", async () => {
  const root = await createTempDir();
  const filter = await GitignoreFilter.for(root);

  expect(() => filter.ignores("src/index.ts")).toThrow(
    "Expected absolute path"
  );
});
