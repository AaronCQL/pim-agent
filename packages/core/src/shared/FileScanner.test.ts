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

    const { paths } = await FileScanner.scan(root, "**/*.ts", {
      ...defaultOptions,
      exclude: ["**/*.test.ts", "src/generated/**"],
    });

    expect(paths).toEqual([join(root, "src", "app.ts")]);
  });

  test("expands a bare directory pattern to everything under it", async () => {
    const root = await createTempDir();
    await mkdir(join(root, "a", "b"), { recursive: true });
    await writeFile(join(root, "top.ts"), "", "utf8");
    await writeFile(join(root, "a", "mid.ts"), "", "utf8");
    await writeFile(join(root, "a", "b", "deep.ts"), "", "utf8");

    for (const pattern of ["a", "a/", "./a"]) {
      const { paths } = await FileScanner.scan(root, pattern, defaultOptions);

      expect(paths.toSorted()).toEqual(
        [join(root, "a", "mid.ts"), join(root, "a", "b", "deep.ts")].sort()
      );
    }
  });

  test("expands an empty pattern to the whole tree", async () => {
    const root = await createTempDir();
    await writeFile(join(root, "top.ts"), "", "utf8");

    expect((await FileScanner.scan(root, "", defaultOptions)).paths).toEqual([
      join(root, "top.ts"),
    ]);
  });

  test("leaves a file pattern untouched", async () => {
    const root = await createTempDir();
    await writeFile(join(root, "top.ts"), "", "utf8");

    expect(
      (await FileScanner.scan(root, "top.ts", defaultOptions)).paths
    ).toEqual([join(root, "top.ts")]);
  });

  describe("skipped repositories", () => {
    const scanRepos = async (
      pattern: string,
      exclude?: readonly string[]
    ): Promise<readonly string[]> => {
      const root = await createTempDir();
      await mkdir(join(root, ".git", "info"), { recursive: true });
      await writeFile(
        join(root, ".git", "info", "exclude"),
        "inner/\nsrc/vendor/x/\n",
        "utf8"
      );
      await mkdir(join(root, "inner", ".git"), { recursive: true });
      await mkdir(join(root, "src", "vendor", "x", ".git"), {
        recursive: true,
      });
      await mkdir(join(root, "untracked"), { recursive: true });
      const { skippedRepos } = await FileScanner.scan(root, pattern, {
        ...defaultOptions,
        exclude,
      });
      return skippedRepos.map((repo) => repo.slice(root.length + 1));
    };

    test("reports those the pattern could reach", async () => {
      expect(await scanRepos("**/*")).toEqual(["inner", "src/vendor/x"]);
      expect(await scanRepos("src/**/*.ts")).toEqual(["src/vendor/x"]);
      expect(await scanRepos("src/vendor/x/*.ts")).toEqual(["src/vendor/x"]);
    });

    test("reports none outside the pattern's literal prefix", async () => {
      expect(await scanRepos("untracked/**")).toEqual([]);
      expect(await scanRepos("untracked")).toEqual([]);
    });

    test("hides those an exclude names", async () => {
      expect(await scanRepos("**/*", ["inner"])).toEqual(["src/vendor/x"]);
      expect(await scanRepos("**/*", ["**/inner"])).toEqual(["src/vendor/x"]);
      expect(await scanRepos("**/*", ["src/vendor/*"])).toEqual(["inner"]);
      expect(await scanRepos("**/*", ["src/**"])).toEqual(["inner"]);
    });
  });
});
