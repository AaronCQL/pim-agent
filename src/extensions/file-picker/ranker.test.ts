import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileCandidate } from "./catalog";
import { rank } from "./ranker";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "pim-file-ranker-"));
});

afterEach(async () => {
  await rm(workspace, { force: true, recursive: true });
});

const file = (path: string): FileCandidate => ({
  insertPath: path,
  displayPath: path,
  matchHaystack: path,
  isDirectory: false,
});

test("relative query with no cache returns undefined (fallback)", async () => {
  const result = await rank("foo", { cachedRelative: undefined });

  expect(result).toBeUndefined();
});

test("relative query with cache fuzzy-ranks the cached catalog", async () => {
  const cachedRelative: readonly FileCandidate[] = [
    file("src/util/log.ts"),
    file("src/util/clock.ts"),
    file("README.md"),
  ];

  const result = await rank("clk", { cachedRelative });

  expect(result).toBeDefined();
  expect(result?.[0]?.value).toBe("src/util/clock.ts");
});

test("empty relative query returns cached catalog in given order", async () => {
  const cachedRelative: readonly FileCandidate[] = [
    file("a.ts"),
    file("b.ts"),
    file("c.ts"),
  ];

  const result = await rank("", {
    cachedRelative,
    limit: 2,
  });

  expect(result?.map((item) => item.value)).toEqual(["a.ts", "b.ts"]);
});

test("absolute query lists the resolved directory", async () => {
  await mkdir(join(workspace, "sub"), { recursive: true });
  await writeFile(join(workspace, "sub", "alpha.ts"), "a");
  await writeFile(join(workspace, "sub", "beta.ts"), "b");

  const result = await rank(`${join(workspace, "sub")}/`, {
    cachedRelative: undefined,
  });

  expect(result?.map((item) => item.label)).toEqual(["alpha.ts", "beta.ts"]);
});

test("absolute query with residual fuzzy-ranks within the directory", async () => {
  await mkdir(join(workspace, "sub"), { recursive: true });
  await writeFile(join(workspace, "sub", "alpha.ts"), "a");
  await writeFile(join(workspace, "sub", "beta.ts"), "b");

  const result = await rank(`${join(workspace, "sub")}/be`, {
    cachedRelative: undefined,
  });

  expect(result?.[0]?.label).toBe("beta.ts");
});

test("directory candidates carry trailing slash in value and label", async () => {
  await mkdir(join(workspace, "sub"), { recursive: true });
  await mkdir(join(workspace, "sub", "child"), { recursive: true });

  const result = await rank(`${join(workspace, "sub")}/`, {
    cachedRelative: undefined,
  });

  const child = result?.find((item) => item.label === "child/");
  expect(child).toBeDefined();
  expect(child?.value.endsWith("/child/")).toBe(true);
});
