import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { findFiles } from "./glob";

const tempRoots: string[] = [];

const tempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "pim-glob-tool-"));
  tempRoots.push(root);
  return root;
};

afterAll(async () => {
  await Promise.all(
    tempRoots.map((root) => rm(root, { force: true, recursive: true }))
  );
});

const defaultScanOptions = {
  includeDotfiles: false,
  includeIgnored: false,
} as const;

describe("findFiles", () => {
  test("sorts by recency desc with path-asc tiebreak when mtimes are equal", async () => {
    const root = await tempRoot();
    const older = join(root, "older.ts");
    const tieB = join(root, "b.ts");
    const tieA = join(root, "a.ts");

    await writeFile(older, "", "utf8");
    await writeFile(tieA, "", "utf8");
    await writeFile(tieB, "", "utf8");

    await utimes(
      older,
      new Date("2024-01-01T00:00:00Z"),
      new Date("2024-01-01T00:00:00Z")
    );
    await utimes(
      tieA,
      new Date("2024-01-02T00:00:00Z"),
      new Date("2024-01-02T00:00:00Z")
    );
    await utimes(
      tieB,
      new Date("2024-01-02T00:00:00Z"),
      new Date("2024-01-02T00:00:00Z")
    );

    const matches = await findFiles(root, "**/*.ts", defaultScanOptions);

    expect(matches.map((match) => match.path)).toEqual([tieA, tieB, older]);
  });

  test("respects gitignore, dotfiles, and the always-ignored defaults", async () => {
    const root = await tempRoot();
    const src = join(root, "src");
    const ignored = join(src, "ignored.ts");
    const kept = join(src, "kept.ts");
    const nodeModules = join(root, "node_modules", "pkg", "x.ts");
    const dot = join(root, ".secret", "x.ts");

    await mkdir(src, { recursive: true });
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(root, ".secret"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "ignored.ts\n", "utf8");
    await writeFile(ignored, "", "utf8");
    await writeFile(kept, "", "utf8");
    await writeFile(nodeModules, "", "utf8");
    await writeFile(dot, "", "utf8");

    const matches = await findFiles(root, "**/*.ts", defaultScanOptions);

    expect(matches.map((match) => match.path)).toEqual([kept]);
  });

  test("can include dotfiles and ignored paths", async () => {
    const root = await tempRoot();
    const kept = join(root, "kept.ts");
    const ignored = join(root, "ignored.ts");
    const dot = join(root, ".secret", "x.ts");

    await mkdir(join(root, ".secret"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "ignored.ts\n", "utf8");
    await writeFile(kept, "", "utf8");
    await writeFile(ignored, "", "utf8");
    await writeFile(dot, "", "utf8");

    const matches = await findFiles(root, "**/*.ts", {
      includeDotfiles: true,
      includeIgnored: true,
    });

    expect(matches.map((match) => match.path).sort()).toEqual(
      [dot, ignored, kept].sort()
    );
  });

  test("filters by glob pattern extension", async () => {
    const root = await tempRoot();
    const ts = join(root, "a.ts");
    const md = join(root, "a.md");

    await writeFile(ts, "", "utf8");
    await writeFile(md, "", "utf8");

    const matches = await findFiles(root, "**/*.ts", defaultScanOptions);

    expect(matches.map((match) => match.path)).toEqual([ts]);
  });

  test("excludes a single glob pattern", async () => {
    const root = await tempRoot();
    const source = join(root, "src", "app.ts");
    const test = join(root, "src", "app.test.ts");

    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(source, "", "utf8");
    await writeFile(test, "", "utf8");

    const matches = await findFiles(root, "**/*.ts", {
      ...defaultScanOptions,
      exclude: ["**/*.test.ts"],
    });

    expect(matches.map((match) => match.path)).toEqual([source]);
  });

  test("excludes multiple glob patterns", async () => {
    const root = await tempRoot();
    const source = join(root, "src", "app.ts");
    const test = join(root, "src", "app.test.ts");
    const generated = join(root, "src", "generated", "types.ts");

    await mkdir(join(root, "src", "generated"), { recursive: true });
    await writeFile(source, "", "utf8");
    await writeFile(test, "", "utf8");
    await writeFile(generated, "", "utf8");

    const matches = await findFiles(root, "**/*.ts", {
      ...defaultScanOptions,
      exclude: ["**/*.test.ts", "src/generated/**"],
    });

    expect(matches.map((match) => match.path)).toEqual([source]);
  });

  test("throws an actionable error when the path does not exist", async () => {
    const root = await tempRoot();
    const missing = join(root, "nope");

    await expect(
      findFiles(missing, "**/*", defaultScanOptions)
    ).rejects.toThrow(
      `Path not found: ${missing}. Use glob to locate the file or directory, or verify the path.`
    );
  });

  test("throws an actionable error when path is a file, not a directory", async () => {
    const root = await tempRoot();
    const file = join(root, "notes.txt");
    await writeFile(file, "hello", "utf8");

    await expect(findFiles(file, "**/*", defaultScanOptions)).rejects.toThrow(
      `Glob path must be a directory: ${file}. Drop "path" and put the filename in "pattern", or use the read tool to inspect a single file.`
    );
  });
});
