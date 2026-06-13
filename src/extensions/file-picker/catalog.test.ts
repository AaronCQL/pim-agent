import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadAbsolute,
  loadRelative,
  type GitSpawnResult,
  type GitSpawner,
} from "./catalog";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "pim-file-catalog-"));
});

afterEach(async () => {
  await rm(workspace, { force: true, recursive: true });
});

const failingSpawner: GitSpawner = async () => ({
  exitCode: 1,
  stdout: "",
});

const succeedingSpawner = (files: readonly string[]): GitSpawner => {
  return async () => ({
    exitCode: 0,
    stdout: files.join("\n"),
  });
};

describe("loadRelative — fast path (git ls-files)", () => {
  test("returns the listed files as forward-slash relative paths", async () => {
    const candidates = await loadRelative({
      root: workspace,
      gitSpawner: succeedingSpawner([
        "src/foo.ts",
        "src/bar/baz.ts",
        "README.md",
      ]),
    });

    const paths = candidates.map((c) => c.displayPath);
    expect(paths).toContain("README.md");
    expect(paths).toContain("src/foo.ts");
    expect(paths).toContain("src/bar/baz.ts");
    for (const candidate of candidates) {
      expect(candidate.insertPath).toBe(candidate.displayPath);
      expect(candidate.matchHaystack).toBe(candidate.displayPath);
    }
    const files = candidates.filter((c) => !c.isDirectory);
    expect(files.map((c) => c.displayPath)).toEqual([
      "README.md",
      "src/bar/baz.ts",
      "src/foo.ts",
    ]);
  });

  test("derives directories from file prefixes", async () => {
    const candidates = await loadRelative({
      root: workspace,
      gitSpawner: succeedingSpawner([
        "src/foo.ts",
        "src/bar/baz.ts",
        "README.md",
      ]),
    });

    const directories = candidates
      .filter((c) => c.isDirectory)
      .map((c) => c.displayPath);
    expect(directories).toEqual(["src", "src/bar"]);
  });

  test("directories sort with their contents", async () => {
    const candidates = await loadRelative({
      root: workspace,
      gitSpawner: succeedingSpawner(["src/foo.ts", "a.ts", "zzz.ts"]),
    });

    expect(candidates.map((c) => c.displayPath)).toEqual([
      "a.ts",
      "src",
      "src/foo.ts",
      "zzz.ts",
    ]);
  });

  test("sorts ascending by relative path", async () => {
    const candidates = await loadRelative({
      root: workspace,
      gitSpawner: succeedingSpawner(["zeta.ts", "alpha.ts", "mu.ts"]),
    });

    expect(candidates.map((c) => c.displayPath)).toEqual([
      "alpha.ts",
      "mu.ts",
      "zeta.ts",
    ]);
  });

  test("limit truncates after sort", async () => {
    const candidates = await loadRelative({
      root: workspace,
      gitSpawner: succeedingSpawner(["c.ts", "a.ts", "b.ts", "d.ts"]),
      limit: 2,
    });

    expect(candidates.map((c) => c.displayPath)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("loadRelative — fallback (Bun.Glob)", () => {
  test("walks the directory and skips gitignored entries", async () => {
    await writeFile(join(workspace, ".gitignore"), "ignored.txt\n");
    await writeFile(join(workspace, "kept.ts"), "kept");
    await writeFile(join(workspace, "ignored.txt"), "ignored");
    await mkdir(join(workspace, "nested"), { recursive: true });
    await writeFile(join(workspace, "nested", "deep.ts"), "deep");
    await mkdir(join(workspace, "node_modules"), { recursive: true });
    await writeFile(join(workspace, "node_modules", "junk.js"), "junk");

    const candidates = await loadRelative({
      root: workspace,
      gitSpawner: failingSpawner,
    });

    const paths = candidates.map((c) => c.displayPath);
    expect(paths).toContain("kept.ts");
    expect(paths).toContain("nested/deep.ts");
    expect(paths).not.toContain("ignored.txt");
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);

    const nested = candidates.find((c) => c.displayPath === "nested");
    expect(nested?.isDirectory).toBe(true);
  });

  test("empty workspace produces an empty list", async () => {
    const candidates = await loadRelative({
      root: workspace,
      gitSpawner: failingSpawner,
    });

    expect(candidates).toEqual([]);
  });
});

describe("loadRelative — coalescing", () => {
  test("two concurrent calls with the same root share one spawn", async () => {
    let invocations = 0;
    const spawner: GitSpawner = async () => {
      invocations += 1;
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 10));
      return { exitCode: 0, stdout: "x.ts\n" } satisfies GitSpawnResult;
    };

    const [a, b] = await Promise.all([
      loadRelative({ root: workspace, gitSpawner: spawner }),
      loadRelative({ root: workspace, gitSpawner: spawner }),
    ]);

    expect(invocations).toBe(1);
    expect(a).toBe(b);
  });

  test("subsequent call after settle re-runs the spawner", async () => {
    let invocations = 0;
    const spawner: GitSpawner = async () => {
      invocations += 1;
      return { exitCode: 0, stdout: "x.ts\n" };
    };

    await loadRelative({ root: workspace, gitSpawner: spawner });
    await loadRelative({ root: workspace, gitSpawner: spawner });

    expect(invocations).toBe(2);
  });
});

describe("loadAbsolute", () => {
  test("anchor at exact directory lists its children", async () => {
    await mkdir(join(workspace, "sub"), { recursive: true });
    await writeFile(join(workspace, "sub", "alpha.ts"), "a");
    await writeFile(join(workspace, "sub", "beta.ts"), "b");
    await mkdir(join(workspace, "sub", "child"), { recursive: true });

    const result = await loadAbsolute({
      query: `${join(workspace, "sub")}/`,
    });

    expect(result.residualQuery).toBe("");
    const names = result.candidates.map((c) => c.matchHaystack);
    expect(names).toEqual(["child", "alpha.ts", "beta.ts"]);
    const child = result.candidates.find((c) => c.matchHaystack === "child");
    expect(child?.isDirectory).toBe(true);
    const alpha = result.candidates.find((c) => c.matchHaystack === "alpha.ts");
    expect(alpha?.isDirectory).toBe(false);
    expect(alpha?.insertPath).toBe(join(workspace, "sub", "alpha.ts"));
  });

  test("anchor at deepest existing prefix produces residual", async () => {
    await mkdir(join(workspace, "sub"), { recursive: true });
    await writeFile(join(workspace, "sub", "partial.ts"), "p");

    const result = await loadAbsolute({
      query: `${join(workspace, "sub")}/parti`,
    });

    expect(result.residualQuery).toBe("parti");
    expect(result.candidates.map((c) => c.matchHaystack)).toEqual([
      "partial.ts",
    ]);
  });

  test("walks past a file that is an exact prefix to the parent directory", async () => {
    await mkdir(join(workspace, "etc"), { recursive: true });
    await writeFile(join(workspace, "etc", "passwd"), "fake");

    const result = await loadAbsolute({
      query: `${join(workspace, "etc", "passwd")}/foo`,
    });

    expect(result.residualQuery).toBe("passwd/foo");
    expect(result.candidates.map((c) => c.matchHaystack)).toEqual(["passwd"]);
  });

  test("normalizes .. segments before walking", async () => {
    await mkdir(join(workspace, "alpha"), { recursive: true });
    await writeFile(join(workspace, "alpha", "x.ts"), "x");
    await mkdir(join(workspace, "beta"), { recursive: true });

    const result = await loadAbsolute({
      query: `${join(workspace, "beta")}/../alpha/`,
    });

    expect(result.residualQuery).toBe("");
    expect(result.candidates.map((c) => c.matchHaystack)).toEqual(["x.ts"]);
  });

  test("nonexistent suffix walks up to the deepest existing ancestor", async () => {
    await mkdir(join(workspace, "real"), { recursive: true });
    await writeFile(join(workspace, "real", "kept.ts"), "k");

    const result = await loadAbsolute({
      query: `${join(workspace, "real")}/nope/foo`,
    });

    expect(result.residualQuery).toBe("nope/foo");
    expect(result.candidates.map((c) => c.matchHaystack)).toEqual(["kept.ts"]);
  });

  test("symlinked directory is treated as a directory anchor", async () => {
    await mkdir(join(workspace, "real"), { recursive: true });
    await writeFile(join(workspace, "real", "x.ts"), "x");
    await symlink(join(workspace, "real"), join(workspace, "link"));

    const result = await loadAbsolute({
      query: `${join(workspace, "link")}/`,
    });

    expect(result.candidates.map((c) => c.matchHaystack)).toEqual(["x.ts"]);
  });

  test("dotfiles hidden unless residual starts with a dot", async () => {
    await mkdir(join(workspace, "sub"), { recursive: true });
    await writeFile(join(workspace, "sub", "visible.ts"), "v");
    await writeFile(join(workspace, "sub", ".hidden"), "h");

    const without = await loadAbsolute({
      query: `${join(workspace, "sub")}/`,
    });
    expect(without.candidates.map((c) => c.matchHaystack)).toEqual([
      "visible.ts",
    ]);

    const withDot = await loadAbsolute({
      query: `${join(workspace, "sub")}/.h`,
    });
    expect(withDot.candidates.map((c) => c.matchHaystack)).toContain(".hidden");
    expect(withDot.residualQuery).toBe(".h");
  });

  test("directories sort before files within the same anchor", async () => {
    await mkdir(join(workspace, "sub"), { recursive: true });
    await writeFile(join(workspace, "sub", "z-file.ts"), "z");
    await mkdir(join(workspace, "sub", "a-dir"), { recursive: true });
    await writeFile(join(workspace, "sub", "a-file.ts"), "a");

    const result = await loadAbsolute({
      query: `${join(workspace, "sub")}/`,
    });

    expect(result.candidates.map((c) => c.matchHaystack)).toEqual([
      "a-dir",
      "a-file.ts",
      "z-file.ts",
    ]);
  });
});
