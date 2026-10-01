import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { FileScanner } from "./FileScanner";

const tempRoots: string[] = [];

const createTempDir = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "pim-file-scanner-"));
  tempRoots.push(root);
  return root;
};

afterAll(async () => {
  await Promise.all(
    tempRoots.map((root) => rm(root, { force: true, recursive: true }))
  );
});

const defaultOptions = {
  includeDotfiles: false,
  includeIgnored: false,
} as const;

describe("FileScanner.scan", () => {
  test("excludes multiple patterns", async () => {
    const root = await createTempDir();
    await mkdir(join(root, "src", "generated"), { recursive: true });
    await writeFile(join(root, "src", "app.ts"), "", "utf8");
    await writeFile(join(root, "src", "app.test.ts"), "", "utf8");
    await writeFile(join(root, "src", "generated", "types.ts"), "", "utf8");

    const files = await FileScanner.scan(root, "**/*.ts", {
      ...defaultOptions,
      exclude: ["**/*.test.ts", "src/generated/**"],
    });

    expect(files).toEqual([join(root, "src", "app.ts")]);
  });

  test("expands a bare directory pattern to everything under it", async () => {
    const root = await createTempDir();
    await mkdir(join(root, "a", "b"), { recursive: true });
    await writeFile(join(root, "top.ts"), "", "utf8");
    await writeFile(join(root, "a", "mid.ts"), "", "utf8");
    await writeFile(join(root, "a", "b", "deep.ts"), "", "utf8");

    for (const pattern of ["a", "a/", "./a"]) {
      const files = await FileScanner.scan(root, pattern, defaultOptions);

      expect(files.toSorted()).toEqual(
        [join(root, "a", "mid.ts"), join(root, "a", "b", "deep.ts")].sort()
      );
    }
  });

  test("expands an empty pattern to the whole tree", async () => {
    const root = await createTempDir();
    await writeFile(join(root, "top.ts"), "", "utf8");

    expect(await FileScanner.scan(root, "", defaultOptions)).toEqual([
      join(root, "top.ts"),
    ]);
  });

  test("leaves a file pattern untouched", async () => {
    const root = await createTempDir();
    await writeFile(join(root, "top.ts"), "", "utf8");

    expect(await FileScanner.scan(root, "top.ts", defaultOptions)).toEqual([
      join(root, "top.ts"),
    ]);
  });
});
