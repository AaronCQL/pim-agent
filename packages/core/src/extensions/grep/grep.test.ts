import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { buildMatcher, findMatches } from "./grep";

const tempRoots: string[] = [];

const tempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "pim-grep-tool-"));
  tempRoots.push(root);
  return root;
};

afterAll(async () => {
  await Promise.all(
    tempRoots.map((root) => rm(root, { force: true, recursive: true }))
  );
});

const makeMatcher = (
  pattern: string,
  options?: {
    readonly caseInsensitive?: boolean;
    readonly matchAcrossLines?: boolean;
  }
) =>
  buildMatcher({
    pattern,
    caseInsensitive: options?.caseInsensitive ?? false,
    matchAcrossLines: options?.matchAcrossLines ?? false,
  });

const defaultScanOptions = {
  includeDotfiles: false,
  includeIgnored: false,
} as const;

describe("buildMatcher", () => {
  test.each([
    [{}, ""],
    [{ caseInsensitive: true }, "i"],
    [{ matchAcrossLines: true }, "s"],
  ])("%j compiles with flags %p", (options, flags) => {
    expect(makeMatcher("alpha", options).regex.flags).toBe(flags);
  });

  test("throws an actionable error on invalid regex syntax", () => {
    expect(() => makeMatcher("(")).toThrow(/Invalid regular expression/);
  });
});

describe("findMatches", () => {
  test("returns content matches with line numbers", async () => {
    const root = await tempRoot();
    const nested = join(root, "nested");
    const older = join(root, "older.txt");
    const newer = join(nested, "newer.txt");

    await mkdir(nested);
    await writeFile(older, "alpha\nbeta", "utf8");
    await writeFile(newer, "gamma\nalphabet\nalpha", "utf8");
    await utimes(
      older,
      new Date("2024-01-01T00:00:00Z"),
      new Date("2024-01-01T00:00:00Z")
    );
    await utimes(
      newer,
      new Date("2024-01-02T00:00:00Z"),
      new Date("2024-01-02T00:00:00Z")
    );

    const matches = await findMatches(
      root,
      undefined,
      makeMatcher("alpha"),
      defaultScanOptions
    );

    expect(matches.map((match) => match.filePath)).toEqual([newer, older]);
    expect(matches[0]?.lines).toEqual([
      { lineNumber: 2, text: "alphabet" },
      { lineNumber: 3, text: "alpha" },
    ]);
    expect(matches[1]?.lines).toEqual([{ lineNumber: 1, text: "alpha" }]);
  });

  test("escapes regex metacharacters when searching literal text", async () => {
    const root = await tempRoot();
    const path = join(root, "code.ts");
    await writeFile(path, "useFoo(\nfoo.bar[0]\n", "utf8");

    const matches = await findMatches(
      root,
      undefined,
      makeMatcher("foo\\.bar\\[0\\]"),
      defaultScanOptions
    );

    expect(matches.map((match) => match.filePath)).toEqual([path]);
    expect(matches[0]?.lines).toEqual([{ lineNumber: 2, text: "foo.bar[0]" }]);
  });

  test("matchAcrossLines enables regex matches spanning line breaks", async () => {
    const root = await tempRoot();
    const path = join(root, "block.txt");
    await writeFile(path, "before\nBEGIN\nmiddle\nEND\nafter\n", "utf8");

    const withoutAcrossLines = await findMatches(
      root,
      undefined,
      makeMatcher("BEGIN.*END"),
      defaultScanOptions
    );
    const withAcrossLines = await findMatches(
      root,
      undefined,
      makeMatcher("BEGIN.*END", { matchAcrossLines: true }),
      defaultScanOptions
    );

    expect(withoutAcrossLines).toEqual([]);
    expect(withAcrossLines.map((match) => match.filePath)).toEqual([path]);
    expect(withAcrossLines[0]?.ranges).toEqual([
      { startLineNumber: 2, endLineNumber: 4 },
    ]);
    expect(withAcrossLines[0]?.lines).toEqual([
      { lineNumber: 2, text: "BEGIN" },
      { lineNumber: 3, text: "middle" },
      { lineNumber: 4, text: "END" },
    ]);
  });

  test("respects gitignore (incl. node_modules) and dotfiles", async () => {
    const root = await tempRoot();
    const src = join(root, "src");
    const ignored = join(src, "ignored.ts");
    const kept = join(src, "kept.ts");
    const nodeModules = join(root, "node_modules", "pkg", "x.ts");
    const dot = join(root, ".secret", "x.ts");

    await mkdir(src, { recursive: true });
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(root, ".secret"), { recursive: true });
    await writeFile(
      join(root, ".gitignore"),
      "ignored.ts\nnode_modules/\n",
      "utf8"
    );
    await writeFile(ignored, "needle\n", "utf8");
    await writeFile(kept, "needle\n", "utf8");
    await writeFile(nodeModules, "needle\n", "utf8");
    await writeFile(dot, "needle\n", "utf8");

    const matches = await findMatches(
      root,
      undefined,
      makeMatcher("needle"),
      defaultScanOptions
    );

    expect(matches.map((match) => match.filePath)).toEqual([kept]);
  });

  test("can include dotfiles and ignored paths", async () => {
    const root = await tempRoot();
    const kept = join(root, "kept.ts");
    const ignored = join(root, "ignored.ts");
    const dot = join(root, ".secret", "x.ts");

    await mkdir(join(root, ".secret"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "ignored.ts\n", "utf8");
    await writeFile(kept, "needle\n", "utf8");
    await writeFile(ignored, "needle\n", "utf8");
    await writeFile(dot, "needle\n", "utf8");

    const matches = await findMatches(root, undefined, makeMatcher("needle"), {
      includeDotfiles: true,
      includeIgnored: true,
    });

    expect(matches.map((match) => match.filePath).sort()).toEqual(
      [dot, ignored, kept].sort()
    );
  });

  test("searches direct file paths even when they are dotfiles or ignored", async () => {
    const root = await tempRoot();
    const ignored = join(root, "ignored.ts");
    const dotfile = join(root, ".env");

    await writeFile(join(root, ".gitignore"), "ignored.ts\n", "utf8");
    await writeFile(ignored, "needle\n", "utf8");
    await writeFile(dotfile, "needle\n", "utf8");

    const ignoredMatches = await findMatches(
      ignored,
      undefined,
      makeMatcher("needle"),
      defaultScanOptions
    );
    const dotfileMatches = await findMatches(
      dotfile,
      undefined,
      makeMatcher("needle"),
      defaultScanOptions
    );

    expect(ignoredMatches.map((match) => match.filePath)).toEqual([ignored]);
    expect(dotfileMatches.map((match) => match.filePath)).toEqual([dotfile]);
  });

  test("filters by glob and excludes patterns", async () => {
    const root = await tempRoot();
    const source = join(root, "src", "app.ts");
    const test = join(root, "src", "app.test.ts");
    const generated = join(root, "src", "generated", "types.ts");

    await mkdir(join(root, "src", "generated"), { recursive: true });
    await writeFile(source, "needle", "utf8");
    await writeFile(test, "needle", "utf8");
    await writeFile(generated, "needle", "utf8");
    await writeFile(join(root, "src", "notes.md"), "needle", "utf8");

    const matches = await findMatches(root, "**/*.ts", makeMatcher("needle"), {
      ...defaultScanOptions,
      exclude: ["**/*.test.ts", "src/generated/**"],
    });

    expect(matches.map((match) => match.filePath)).toEqual([source]);
  });

  test("skips binary files", async () => {
    const root = await tempRoot();
    const text = join(root, "text.txt");
    const binary = join(root, "data.bin");

    await writeFile(text, "needle\n", "utf8");
    await Bun.write(binary, new Uint8Array([0x6e, 0x00, 0x65, 0x65]));

    const matches = await findMatches(
      root,
      undefined,
      makeMatcher("n"),
      defaultScanOptions
    );

    expect(matches.map((match) => match.filePath)).toEqual([text]);
  });

  test("throws an actionable error when the path does not exist", async () => {
    const root = await tempRoot();
    const missing = join(root, "nope");

    await expect(
      findMatches(missing, undefined, makeMatcher("x"), defaultScanOptions)
    ).rejects.toThrow(
      `Path not found: ${missing}. Use glob to locate the file or directory, or verify the path.`
    );
  });

  test("skips a symlink to a directory without failing the scan", async () => {
    const root = await tempRoot();
    const target = join(root, "target");
    const readable = join(root, "readable.txt");

    await mkdir(target);
    await writeFile(join(target, "inner.txt"), "alpha", "utf8");
    await writeFile(readable, "alpha", "utf8");
    await symlink(target, join(root, "linkdir"));

    const matches = await findMatches(
      root,
      undefined,
      makeMatcher("alpha"),
      defaultScanOptions
    );

    expect(matches.map((match) => match.filePath).toSorted()).toEqual([
      readable,
      join(target, "inner.txt"),
    ]);
  });

  test("skips a broken symlink without failing the scan", async () => {
    const root = await tempRoot();
    const readable = join(root, "readable.txt");

    await writeFile(readable, "alpha", "utf8");
    await symlink(join(root, "missing-target"), join(root, "broken.txt"));

    const matches = await findMatches(
      root,
      undefined,
      makeMatcher("alpha"),
      defaultScanOptions
    );

    expect(matches.map((match) => match.filePath)).toEqual([readable]);
  });

  test.skipIf(process.getuid?.() === 0)(
    "skips an unreadable file without failing the scan",
    async () => {
      const root = await tempRoot();
      const readable = join(root, "readable.txt");
      const locked = join(root, "locked.txt");

      await writeFile(readable, "alpha", "utf8");
      await writeFile(locked, "alpha", "utf8");
      await chmod(locked, 0o000);

      const matches = await findMatches(
        root,
        undefined,
        makeMatcher("alpha"),
        defaultScanOptions
      );

      await chmod(locked, 0o644);

      expect(matches.map((match) => match.filePath)).toEqual([readable]);
    }
  );

  test("still resolves a symlinked directory passed directly as the path", async () => {
    const root = await tempRoot();
    const target = join(root, "target");
    const link = join(root, "linkdir");

    await mkdir(target);
    await writeFile(join(target, "inner.txt"), "alpha", "utf8");
    await symlink(target, link);

    const matches = await findMatches(
      link,
      undefined,
      makeMatcher("alpha"),
      defaultScanOptions
    );

    expect(matches.map((match) => match.filePath)).toEqual([
      join(link, "inner.txt"),
    ]);
  });
});
