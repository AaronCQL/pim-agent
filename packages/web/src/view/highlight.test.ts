import "../test/dom";

import { describe, expect, test } from "bun:test";

import { tokenized } from "../test/highlight";
import { Highlight, type Token } from "./highlight";

const text = (lines: readonly (readonly Token[])[]): readonly string[] =>
  lines.map((line) => line.map((token) => token.text).join(""));

describe("Highlight.tokenize", () => {
  // Go, and nothing else here: a language another test has already asked for
  // is one this test cannot be the first to ask about.
  test("a language nobody has asked for yet comes back plain, then coloured", async () => {
    expect(Highlight.tokenize("const a = 1", "go")).toEqual([
      [{ text: "const a = 1" }],
    ]);

    const [line] = await tokenized("const a = 1", "go");

    expect(line?.find((token) => token.text === "const")?.role).toBe("keyword");
    expect(line?.find((token) => token.text === "1")?.role).toBe("number");
  });

  test("an unknown language is left alone rather than guessed at", () => {
    expect(Highlight.tokenize("not code at all", undefined)).toEqual([
      [{ text: "not code at all" }],
    ]);
    expect(Highlight.tokenize("x := 1", "unwritten")).toEqual([
      [{ text: "x := 1" }],
    ]);
  });

  test("tokens are cut at newlines, and no character is lost", async () => {
    const source = 'const greeting = "hi";\n\nfunction f() {}';
    const lines = await tokenized(source, "typescript");

    expect(text(lines)).toEqual(source.split("\n"));
  });

  /**
   * The reason blocks are highlighted whole rather than line by line: the
   * middle line of a block comment is only a comment because of the line above
   * it, and a per-line highlighter would paint it as code.
   */
  test("a construct spanning lines keeps its colour on every one of them", async () => {
    const lines = await tokenized(
      "/**\n * doc\n */\nconst a = 1;",
      "typescript"
    );

    expect(
      lines
        .slice(0, 3)
        .flat()
        .map((token) => token.role)
    ).toEqual(["comment", "comment", "comment"]);
  });

  test("markup in the source cannot escape into the tokens", async () => {
    const lines = await tokenized('const a = "<img src=x>";', "typescript");

    expect(text(lines).join("")).toContain('"<img src=x>"');
  });

  /**
   * A fenced ```diff is the one language whose whole body is scopes no other
   * grammar emits, so forgetting to map them leaves the block plain apart
   * from its hunk header.
   */
  test("a diff colours its added and removed lines", async () => {
    const lines = await tokenized(
      "@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n unchanged",
      "diff"
    );

    expect(lines.map((line) => line[0]?.role)).toEqual([
      "meta",
      "removed",
      "added",
      undefined,
    ]);
  });
});

/**
 * highlight.js is synchronous and the tab has nothing else to run while it
 * works, so past a point the only responsive answer is the text itself.
 */
describe("the size cap", () => {
  const roles = (lines: readonly (readonly Token[])[]) =>
    lines.flat().map((token) => token.role);

  test("a block past a hundred kilobytes comes back plain", async () => {
    await tokenized("const a = 1;", "typescript");
    const wide = `const a = "${"x".repeat(2000)}";\n`.repeat(100);

    const lines = Highlight.tokenize(wide, "typescript");

    expect(wide.length).toBeGreaterThan(200_000);
    expect(roles(lines).every((role) => role === undefined)).toBe(true);
    expect(text(lines)[0]).toBe(wide.split("\n")[0]);
  });

  test("a block past two thousand lines comes back plain", async () => {
    await tokenized("const a = 1;", "typescript");
    const tall = "const a = 1;\n".repeat(2001);

    const lines = Highlight.tokenize(tall, "typescript");

    expect(tall.length).toBeLessThan(100_000);
    expect(roles(lines).every((role) => role === undefined)).toBe(true);
  });

  test("a block under both caps is still coloured", async () => {
    await tokenized("const a = 1;", "typescript");

    const lines = Highlight.tokenize(
      "const a = 1;\n".repeat(1999),
      "typescript"
    );

    expect(roles(lines)).toContain("keyword");
  });
});
