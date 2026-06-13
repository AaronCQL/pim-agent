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
  test("scans a directory and returns absolute file paths", async () => {
    const root = await createTempDir();
    await writeFile(join(root, "a.ts"), "", "utf8");
    await writeFile(join(root, "b.ts"), "", "utf8");

    const files = await FileScanner.scan(root, "**/*.ts", defaultOptions);

    expect(files.toSorted()).toEqual(
      [join(root, "a.ts"), join(root, "b.ts")].sort()
    );
  });

  test("respects gitignore patterns", async () => {
    const root = await createTempDir();
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "ignored.ts\n", "utf8");
    await writeFile(join(root, "kept.ts"), "", "utf8");
    await writeFile(join(root, "ignored.ts"), "", "utf8");

    const files = await FileScanner.scan(root, "**/*.ts", defaultOptions);

    expect(files).toEqual([join(root, "kept.ts")]);
  });

  test("skips dotfiles by default", async () => {
    const root = await createTempDir();
    await mkdir(join(root, ".hidden"), { recursive: true });
    await writeFile(join(root, ".hidden", "secret.ts"), "", "utf8");
    await writeFile(join(root, "visible.ts"), "", "utf8");

    const files = await FileScanner.scan(root, "**/*.ts", defaultOptions);

    expect(files).toEqual([join(root, "visible.ts")]);
  });

  test("includes dotfiles when requested", async () => {
    const root = await createTempDir();
    await mkdir(join(root, ".hidden"), { recursive: true });
    await writeFile(join(root, ".hidden", "secret.ts"), "", "utf8");
    await writeFile(join(root, "visible.ts"), "", "utf8");

    const files = await FileScanner.scan(root, "**/*.ts", {
      ...defaultOptions,
      includeDotfiles: true,
    });

    expect(files.toSorted()).toEqual(
      [join(root, ".hidden", "secret.ts"), join(root, "visible.ts")].sort()
    );
  });

  test("includes ignored files when requested", async () => {
    const root = await createTempDir();
    await writeFile(join(root, ".gitignore"), "ignored.ts\n", "utf8");
    await writeFile(join(root, "kept.ts"), "", "utf8");
    await writeFile(join(root, "ignored.ts"), "", "utf8");

    const files = await FileScanner.scan(root, "**/*.ts", {
      ...defaultOptions,
      includeIgnored: true,
    });

    expect(files.toSorted()).toEqual(
      [join(root, "ignored.ts"), join(root, "kept.ts")].sort()
    );
  });

  test("excludes patterns via the exclude option", async () => {
    const root = await createTempDir();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "app.ts"), "", "utf8");
    await writeFile(join(root, "src", "app.test.ts"), "", "utf8");

    const files = await FileScanner.scan(root, "**/*.ts", {
      ...defaultOptions,
      exclude: ["**/*.test.ts"],
    });

    expect(files).toEqual([join(root, "src", "app.ts")]);
  });

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

  test("returns an empty array for an empty directory", async () => {
    const root = await createTempDir();

    const files = await FileScanner.scan(root, "**/*", defaultOptions);

    expect(files).toEqual([]);
  });

  test("scans nested directories", async () => {
    const root = await createTempDir();
    await mkdir(join(root, "a", "b", "c"), { recursive: true });
    await writeFile(join(root, "a", "top.ts"), "", "utf8");
    await writeFile(join(root, "a", "b", "mid.ts"), "", "utf8");
    await writeFile(join(root, "a", "b", "c", "deep.ts"), "", "utf8");

    const files = await FileScanner.scan(root, "**/*.ts", defaultOptions);

    expect(files.toSorted()).toEqual(
      [
        join(root, "a", "top.ts"),
        join(root, "a", "b", "mid.ts"),
        join(root, "a", "b", "c", "deep.ts"),
      ].sort()
    );
  });
});
