import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, makeRepo } from "../shared/fixtures/repo";
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

const isListing = (args: readonly string[]) => args.includes("--stage");

const succeedingSpawner = (files: readonly string[]): GitSpawner => {
  return async (args) => ({
    exitCode: 0,
    stdout: isListing(args) ? files.join("\0") : "",
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
});

describe("loadRelative — nested repositories", () => {
  const filesOf = async (root: string): Promise<readonly string[]> =>
    (await loadRelative({ root }))
      .filter((candidate) => !candidate.isDirectory)
      .map((candidate) => candidate.displayPath);

  const makeInner = async (dir: string): Promise<void> => {
    await mkdir(dir, { recursive: true });
    await makeRepo(dir);
    await writeFile(join(dir, "a.ts"), "a");
  };

  test("lists an ignored nested repository under its own ignore rules", async () => {
    await makeRepo(workspace);
    await writeFile(join(workspace, ".gitignore"), "inner/\n*.log\n");
    await makeInner(join(workspace, "inner"));
    await writeFile(join(workspace, "inner", ".gitignore"), "*.tmp\n");
    await writeFile(join(workspace, "inner", "b.tmp"), "b");
    await writeFile(join(workspace, "inner", "c.log"), "c");

    expect(await filesOf(workspace)).toEqual([
      ".gitignore",
      "inner/.gitignore",
      "inner/a.ts",
      "inner/c.log",
    ]);
  });

  test("lists an untracked nested repository's files instead of its directory", async () => {
    await makeRepo(workspace);
    await makeInner(join(workspace, "inner"));
    await makeInner(join(workspace, "inner", "deeper"));

    const candidates = await loadRelative({ root: workspace });

    expect(candidates.map((c) => [c.displayPath, c.isDirectory])).toEqual([
      ["inner", true],
      ["inner/a.ts", false],
      ["inner/deeper", true],
      ["inner/deeper/a.ts", false],
    ]);
  });

  test("lists a submodule's files", async () => {
    const source = join(workspace, "source");
    const outer = join(workspace, "outer");
    await makeInner(source);
    await git(source, ["add", "a.ts"]);
    await git(source, ["commit", "-m", "a"]);
    await mkdir(outer);
    await makeRepo(outer);
    await git(outer, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      source,
      "sub",
    ]);

    expect(await filesOf(outer)).toEqual([".gitmodules", "sub/a.ts"]);
  });

  test("never runs git inside an ignored directory that is not a repository", async () => {
    await makeRepo(workspace);
    await writeFile(join(workspace, ".gitignore"), "node_modules/\n");
    await mkdir(join(workspace, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(workspace, "node_modules", "pkg", "x.js"), "x");
    await makeInner(join(workspace, "node_modules", "repo"));
    const cwds = new Set<string>();
    const real: GitSpawner = async (args, options) => {
      cwds.add(options.cwd);
      const child = Bun.spawn(["git", ...args], {
        cwd: options.cwd,
        stdout: "pipe",
      });
      const stdout = await new Response(child.stdout).text();
      return { exitCode: await child.exited, stdout };
    };

    const candidates = await loadRelative({
      root: workspace,
      gitSpawner: real,
    });

    expect(candidates.map((c) => c.displayPath)).toEqual([".gitignore"]);
    expect([...cwds]).toEqual([workspace]);
  });

  test("skips a worktree of the same repository", async () => {
    await makeRepo(workspace);
    await writeFile(join(workspace, ".gitignore"), "ignored-wt/\n");
    await git(workspace, ["worktree", "add", "wt"]);
    await git(workspace, ["worktree", "add", "ignored-wt"]);

    expect(await filesOf(workspace)).toEqual([".gitignore"]);
  });
});

describe("loadRelative — fallback (Bun.Glob)", () => {
  test("walks the directory and skips gitignored entries", async () => {
    await mkdir(join(workspace, ".git"), { recursive: true });
    await writeFile(
      join(workspace, ".gitignore"),
      "ignored.txt\nnode_modules/\n"
    );
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
});

describe("loadRelative — coalescing", () => {
  test("two concurrent calls with the same root share one spawn", async () => {
    let invocations = 0;
    let release = () => {};
    const released = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    const spawner: GitSpawner = async (args) => {
      if (isListing(args)) {
        invocations += 1;
      }
      await released;
      return { exitCode: 0, stdout: "x.ts\0" } satisfies GitSpawnResult;
    };

    const pending = Promise.all([
      loadRelative({ root: workspace, gitSpawner: spawner }),
      loadRelative({ root: workspace, gitSpawner: spawner }),
    ]);
    release();
    const [a, b] = await pending;

    expect(invocations).toBe(1);
    expect(a).toBe(b);
  });

  test("subsequent call after settle re-runs the spawner", async () => {
    let invocations = 0;
    const spawner: GitSpawner = async (args) => {
      if (isListing(args)) {
        invocations += 1;
      }
      return { exitCode: 0, stdout: "x.ts\0" };
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
});
