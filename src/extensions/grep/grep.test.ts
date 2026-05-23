import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { buildMatcher, findMatches } from "./grep";

const tempRoot = (): Promise<string> =>
  mkdtemp(join(tmpdir(), "pim-grep-tool-"));

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
  test("compiles regexes with no flags by default", () => {
    const matcher = makeMatcher("alpha");
    expect(matcher.regex.flags).toBe("");
    expect(matcher.regex.test("alpha")).toBe(true);
    expect(matcher.regex.test("Alpha")).toBe(false);
  });

  test("applies the i flag for caseInsensitive regexes", () => {
    const matcher = makeMatcher("alpha", { caseInsensitive: true });
    expect(matcher.regex.flags).toBe("i");
    expect(matcher.regex.test("Alpha")).toBe(true);
  });

  test("applies the s flag for matchAcrossLines regexes", () => {
    const matcher = makeMatcher(".", { matchAcrossLines: true });
    expect(matcher.regex.flags).toBe("s");
    expect(matcher.regex.test("\n")).toBe(true);
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

  test("supports regular expressions", async () => {
    const root = await tempRoot();
    const path = join(root, "code.ts");
    await writeFile(path, "alpha\nbeta\n", "utf8");

    const matches = await findMatches(
      root,
      undefined,
      makeMatcher("^a.*a$"),
      defaultScanOptions
    );

    expect(matches.map((match) => match.filePath)).toEqual([path]);
    expect(matches[0]?.lines).toEqual([{ lineNumber: 1, text: "alpha" }]);
  });

  test("matches escaped dots and alternation as regex syntax", async () => {
    const root = await tempRoot();
    const schema = join(root, "src", "extensions", "todo", "schema.ts");
    const helper = join(root, "src", "shared", "arrays.ts");

    await mkdir(join(root, "src", "extensions", "todo"), { recursive: true });
    await mkdir(join(root, "src", "shared"), { recursive: true });
    await writeFile(schema, "const x = Type.Union([Type.String()]);\n", "utf8");
    await writeFile(
      helper,
      "export const oneOrMany = normalizeArray;\n",
      "utf8"
    );

    const typeUnionMatches = await findMatches(
      root,
      "src/extensions/**/schema.ts",
      makeMatcher("Type\\.Union"),
      defaultScanOptions
    );
    const alternationMatches = await findMatches(
      root,
      "src/**/*.ts",
      makeMatcher("StringOrArray|OneOrMany|oneOrMany|normalizeArray"),
      defaultScanOptions
    );

    expect(typeUnionMatches.map((match) => match.filePath)).toEqual([schema]);
    expect(alternationMatches.map((match) => match.filePath)).toEqual([helper]);
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

  test("matchAcrossLines enables exact regex matches spanning line breaks", async () => {
    const root = await tempRoot();
    const path = join(root, "block.txt");
    await writeFile(path, "BEGIN\nmiddle\nEND\n", "utf8");

    const matches = await findMatches(
      root,
      undefined,
      makeMatcher("BEGIN\nmiddle", { matchAcrossLines: true }),
      defaultScanOptions
    );

    expect(matches.map((match) => match.filePath)).toEqual([path]);
    expect(matches[0]?.ranges).toEqual([
      { startLineNumber: 1, endLineNumber: 2 },
    ]);
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

  test("filters by glob", async () => {
    const root = await tempRoot();
    const ts = join(root, "a.ts");
    const md = join(root, "a.md");

    await writeFile(ts, "needle", "utf8");
    await writeFile(md, "needle", "utf8");

    const matches = await findMatches(
      root,
      "**/*.ts",
      makeMatcher("needle"),
      defaultScanOptions
    );

    expect(matches.map((match) => match.filePath)).toEqual([ts]);
  });

  test("excludes a single glob pattern", async () => {
    const root = await tempRoot();
    const source = join(root, "src", "app.ts");
    const test = join(root, "src", "app.test.ts");

    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(source, "needle", "utf8");
    await writeFile(test, "needle", "utf8");

    const matches = await findMatches(root, "**/*.ts", makeMatcher("needle"), {
      ...defaultScanOptions,
      exclude: ["**/*.test.ts"],
    });

    expect(matches.map((match) => match.filePath)).toEqual([source]);
  });

  test("excludes multiple glob patterns", async () => {
    const root = await tempRoot();
    const source = join(root, "src", "app.ts");
    const test = join(root, "src", "app.test.ts");
    const generated = join(root, "src", "generated", "types.ts");

    await mkdir(join(root, "src", "generated"), { recursive: true });
    await writeFile(source, "needle", "utf8");
    await writeFile(test, "needle", "utf8");
    await writeFile(generated, "needle", "utf8");

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

  test("matches a single file path directly", async () => {
    const root = await tempRoot();
    const path = join(root, "notes.txt");
    await writeFile(path, "alpha\nbeta\nalphabet", "utf8");

    const matches = await findMatches(
      path,
      undefined,
      makeMatcher("alpha"),
      defaultScanOptions
    );

    expect(matches.length).toBe(1);
    expect(matches[0]?.lines).toEqual([
      { lineNumber: 1, text: "alpha" },
      { lineNumber: 3, text: "alphabet" },
    ]);
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
});
