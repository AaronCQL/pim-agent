import "../test/dom";

import { describe, expect, test } from "bun:test";

import { Highlight, type Token } from "./highlight";

/**
 * Grammars load on demand, so the first ask for a language is always plain
 * text and the answer arrives a microtask or two later. Every test here waits
 * that out once; the wait is the behaviour, not a workaround for it.
 */
async function tokenize(
  code: string,
  lang: string
): Promise<readonly (readonly Token[])[]> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const lines = Highlight.tokenize(code, lang);
    if (lines.some((line) => line.some((token) => token.role !== undefined))) {
      return lines;
    }
    await Bun.sleep(10);
  }
  throw new Error(`grammar for ${lang} never arrived`);
}

const text = (lines: readonly (readonly Token[])[]): readonly string[] =>
  lines.map((line) => line.map((token) => token.text).join(""));

describe("Highlight.tokenize", () => {
  test("a language nobody has asked for yet comes back plain, then coloured", async () => {
    expect(Highlight.tokenize("const a = 1;", "typescript")).toEqual([
      [{ text: "const a = 1;" }],
    ]);

    const [line] = await tokenize("const a = 1;", "typescript");

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
    const lines = await tokenize(source, "typescript");

    expect(text(lines)).toEqual(source.split("\n"));
  });

  /**
   * The reason blocks are highlighted whole rather than line by line: the
   * middle line of a block comment is only a comment because of the line above
   * it, and a per-line highlighter would paint it as code.
   */
  test("a construct spanning lines keeps its colour on every one of them", async () => {
    const lines = await tokenize(
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
    const lines = await tokenize('const a = "<img src=x>";', "typescript");

    expect(text(lines).join("")).toContain('"<img src=x>"');
  });

  /**
   * A fenced ```diff is the one language whose whole body is scopes no other
   * grammar emits, so forgetting to map them leaves the block plain apart
   * from its hunk header.
   */
  test("a diff colours its added and removed lines", async () => {
    const lines = await tokenize(
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
