import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { FileEnumerator } from "./FileEnumerator";

const enumerate = (
  root: string,
  opts?: Parameters<typeof FileEnumerator.enumerate>[1]
) => FileEnumerator.enumerate(root, opts);

let root: string;
let previousXdgConfigHome: string | undefined;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "pim-enumerate-"));
  previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(root, ".xdg");

  const write = (rel: string, content = "") => {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  };

  // A .git here makes root a repository, so its .gitignore is honored.
  write(".git/HEAD", "ref");
  write(".git/config", "cfg");
  mkdirSync(join(root, ".git", "info"), { recursive: true });
  writeFileSync(
    join(root, ".git", "info", "exclude"),
    "excluded-by-info.txt\n"
  );

  // Tracked source files.
  write("a.ts", "a");
  write("src/index.ts", "i");
  write("src/util/helpers.ts", "h");
  write("README.md", "r");

  // Dotfiles / dot-dirs.
  write(".env", "secret");
  write(".github/workflows/ci.yml", "ci");

  write("excluded-by-info.txt", "x");

  // Global git ignore, via $XDG_CONFIG_HOME/git/ignore.
  write(".xdg/git/ignore", "**/global-ignore.txt\n");
  write("global-ignore.txt", "g");

  // Root .gitignore: ignore logs, but keep one log; anchored + scoped rules.
  write(
    ".gitignore",
    "node_modules/\n*.log\n!keep.log\n/root-only.txt\nsrc/*.gen\n"
  );
  write("debug.log", "d");
  write("keep.log", "k");
  write("root-only.txt", "ro");
  write("sub/root-only.txt", "sub-ro");
  write("src/generated.gen", "gen");
  write("generated.gen", "root-gen");
  write("node_modules/pkg/index.js", "n");

  // Nested .gitignore scoped to src/: ignore *.tmp there only.
  write("src/.gitignore", "*.tmp\n");
  write("src/scratch.tmp", "t");
  write("root.tmp", "rt"); // not ignored — nested rule is scoped to src/
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });

  if (previousXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
  }
});

describe("FileEnumerator.enumerate", () => {
  it("recursively enumerates files only", async () => {
    const paths = await enumerate(root);
    expect(paths).toContain("a.ts");
    expect(paths).toContain("src/index.ts");
    expect(paths).toContain("src/util/helpers.ts");
    expect(paths).toContain("README.md");
    expect(paths).not.toContain("src");
    expect(paths).not.toContain("src/util");
  });

  it("emits directories with a trailing slash when requested", async () => {
    const paths = await enumerate(root, { includeDirectories: true });
    expect(paths).toContain("src/");
    expect(paths).toContain("src/util/");
    expect(paths).toContain("a.ts");
  });

  it("excludes dotfiles by default, includes them with includeDotfiles", async () => {
    const def = await enumerate(root);
    expect(def).not.toContain(".env");
    expect(def.some((p) => p.startsWith(".github/"))).toBe(false);

    const withDots = await enumerate(root, { includeDotfiles: true });
    expect(withDots).toContain(".env");
    expect(withDots).toContain(".github/workflows/ci.yml");
    expect(withDots).toContain(".gitignore");
  });

  it("always prunes the .git directory, even with includeDotfiles", async () => {
    const everything = await enumerate(root, {
      includeDotfiles: true,
      includeIgnored: true,
    });
    expect(everything.some((p) => p === ".git" || p.startsWith(".git/"))).toBe(
      false
    );
  });

  it("applies a gitignored directory like node_modules/", async () => {
    const paths = await enumerate(root);
    expect(paths.some((p) => p.startsWith("node_modules/"))).toBe(false);
  });

  it("honors root-relative and anchored .gitignore patterns", async () => {
    const paths = await enumerate(root);
    expect(paths).not.toContain("src/generated.gen");
    expect(paths).toContain("generated.gen");
    expect(paths).not.toContain("root-only.txt");
    expect(paths).toContain("sub/root-only.txt");
  });

  it("honors .git/info/exclude", async () => {
    const paths = await enumerate(root);
    expect(paths).not.toContain("excluded-by-info.txt");
  });

  it("honors the global git ignore file", async () => {
    const paths = await enumerate(root);
    expect(paths).not.toContain("global-ignore.txt");
  });

  it("honors negation rules (!keep.log after *.log)", async () => {
    const paths = await enumerate(root);
    expect(paths).toContain("keep.log");
    expect(paths).not.toContain("debug.log");
  });

  it("includeIgnored brings back gitignored paths", async () => {
    const paths = await enumerate(root, { includeIgnored: true });
    expect(paths).toContain("debug.log");
    expect(paths).toContain("excluded-by-info.txt");
    expect(paths).toContain("global-ignore.txt");
    expect(paths).toContain("node_modules/pkg/index.js");
    expect(paths).not.toContain(".env");
  });

  it("scopes a nested .gitignore to its subtree", async () => {
    const paths = await enumerate(root);
    expect(paths).not.toContain("src/scratch.tmp");
    expect(paths).toContain("root.tmp");
  });
});

describe("FileEnumerator.enumerate repo-awareness", () => {
  describe("non-repo directory", () => {
    let nonRepo: string;

    beforeAll(() => {
      nonRepo = mkdtempSync(join(tmpdir(), "pim-nonrepo-"));
      const write = (rel: string, content = "") => {
        const abs = join(nonRepo, rel);
        mkdirSync(join(abs, ".."), { recursive: true });
        writeFileSync(abs, content);
      };
      write(".gitignore", "loose-ignored.txt\n");
      write("loose-ignored.txt", "x");
      write("normal.txt", "y");
    });

    afterAll(() => rmSync(nonRepo, { recursive: true, force: true }));

    it("does not honor a .gitignore outside a git repository", async () => {
      // Matches git/fd (and ripgrep's default): a .gitignore with no enclosing
      // repo is inert, so the listed file is still enumerated.
      const paths = await enumerate(nonRepo);
      expect(paths).toContain("normal.txt");
      expect(paths).toContain("loose-ignored.txt");
    });
  });

  describe("nested repository boundary", () => {
    let outer: string;

    beforeAll(() => {
      outer = mkdtempSync(join(tmpdir(), "pim-outerrepo-"));
      const write = (rel: string, content = "") => {
        const abs = join(outer, rel);
        mkdirSync(join(abs, ".."), { recursive: true });
        writeFileSync(abs, content);
      };
      mkdirSync(join(outer, ".git"), { recursive: true });
      write(".gitignore", "*.cross\n");
      write("outer.cross", "a");
      write("keep.txt", "b");
      mkdirSync(join(outer, "inner", ".git"), { recursive: true });
      write("inner/.gitignore", "inner-only.txt\n");
      write("inner/inner.cross", "c");
      write("inner/inner-only.txt", "d");
      write("inner/kept.txt", "e");
    });

    afterAll(() => rmSync(outer, { recursive: true, force: true }));

    it("resets ignore scope at the nested .git boundary", async () => {
      const paths = await enumerate(outer);
      expect(paths).not.toContain("outer.cross");
      expect(paths).toContain("keep.txt");
      expect(paths).toContain("inner/inner.cross");
      expect(paths).not.toContain("inner/inner-only.txt");
      expect(paths).toContain("inner/kept.txt");
    });
  });

  describe("cross-file negation re-includes a subtree", () => {
    let repo: string;

    beforeAll(() => {
      repo = mkdtempSync(join(tmpdir(), "pim-negation-"));
      const write = (rel: string, content = "") => {
        const abs = join(repo, rel);
        mkdirSync(join(abs, ".."), { recursive: true });
        writeFileSync(abs, content);
      };
      mkdirSync(join(repo, ".git"), { recursive: true });
      // Modeled on flutter: `build/` ignored at the repo root, re-included by
      // `!build/` in a deep .gitignore. Only works when all of a repo's rules
      // are evaluated together (one matcher anchored at the repo root).
      write(".gitignore", "build/\n");
      write("engine/src/.gitignore", "!build/\n");
      write("engine/src/build/find.py", "a");
      write("engine/src/build/sub/deep.py", "b");
      write("build/top.py", "c");
      write("engine/build/mid.py", "d");
      write("engine/src/keep.py", "e");
    });

    afterAll(() => rmSync(repo, { recursive: true, force: true }));

    it("walks a subtree re-included by a nested `!` rule", async () => {
      const paths = await enumerate(repo);
      expect(paths).toContain("engine/src/build/find.py");
      expect(paths).toContain("engine/src/build/sub/deep.py");
      expect(paths).toContain("engine/src/keep.py");
      expect(paths).not.toContain("build/top.py");
      expect(paths).not.toContain("engine/build/mid.py");
    });
  });

  describe("a `!` negation re-includes an otherwise-hidden dotfile", () => {
    let repo: string;

    beforeAll(() => {
      repo = mkdtempSync(join(tmpdir(), "pim-dotneg-"));
      const write = (rel: string, content = "") => {
        const abs = join(repo, rel);
        mkdirSync(join(abs, ".."), { recursive: true });
        writeFileSync(abs, content);
      };
      mkdirSync(join(repo, ".git"), { recursive: true });
      write(".gitignore", ".idea/\n");
      write("pkg/.gitignore", "!.idea/\n");
      write("pkg/.idea/workspace.xml", "a");
      write("sub/.idea/other.xml", "b");
      write(".plainhidden", "c");
      write("visible.txt", "d");
    });

    afterAll(() => rmSync(repo, { recursive: true, force: true }));

    it("keeps a negated hidden path, drops un-negated ones", async () => {
      const paths = await enumerate(repo);
      expect(paths).toContain("pkg/.idea/workspace.xml");
      expect(paths).toContain("visible.txt");
      expect(paths).not.toContain("sub/.idea/other.xml");
      expect(paths).not.toContain(".plainhidden");
    });
  });
});
