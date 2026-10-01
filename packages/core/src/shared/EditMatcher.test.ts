import { describe, expect, test } from "bun:test";
import { EditMatcher } from "./EditMatcher";

const replace = (
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false
): string => {
  const resolved = EditMatcher.resolve(content, oldString, replaceAll);
  const ranges = "ranges" in resolved ? resolved.ranges : [resolved.range];
  return EditMatcher.applyAll(
    content,
    ranges.map((range) => ({ range, newString }))
  );
};

describe("EditMatcher", () => {
  test.each([
    ["simple", "alpha\nbeta\ngamma", "beta", "delta", "alpha\ndelta\ngamma"],
    [
      "lineTrimmed",
      "alpha\n  beta\ngamma",
      "beta ",
      "delta",
      "alpha\ndelta\ngamma",
    ],
    [
      "whitespaceNormalized",
      "alpha\nfoo     bar\ngamma",
      "foo bar",
      "baz",
      "alpha\nbaz\ngamma",
    ],
    [
      "indentationFlexible",
      "root\n    if (ok) {\n      run()\n    }\nend",
      "if (ok) {\n  run()\n}",
      "done()",
      "root\ndone()\nend",
    ],
    [
      "escapeNormalized",
      "alpha\nbeta\ngamma",
      "beta\\ngamma",
      "delta",
      "alpha\ndelta",
    ],
    [
      "trimmedBoundary",
      "alpha\nbeta\ngamma",
      "\n beta \n",
      "delta",
      "alpha\ndelta\ngamma",
    ],
    ["unicodeNormalized", "say “hello” now", 'say "hello" now', "done", "done"],
    [
      "contextAware",
      "start\nsame\nactual\nend",
      "start\nsame\nexpected\nend",
      "done",
      "done",
    ],
  ])("%s", (_, content, oldString, newString, expected) => {
    expect(replace(content, oldString, newString)).toBe(expected);
  });

  test("uses blockAnchor fallback with same-line-count constraint", () => {
    const content = [
      "start",
      "actual middle",
      "end",
      "start",
      "one",
      "two",
      "three",
      "end",
    ].join("\n");

    expect(replace(content, "start\nexpected middle\nend", "done")).toBe(
      ["done", "start", "one", "two", "three", "end"].join("\n")
    );
  });

  test("blockAnchor matches 3-line region with drifted middle", () => {
    const content = ["start", "drifted middle", "end"].join("\n");
    expect(replace(content, "start\nexpected middle\nend", "done")).toBe(
      "done"
    );
  });

  test("replaceAll returns every occurrence", () => {
    expect(replace("foo\nbar\nfoo", "foo", "baz", true)).toBe("baz\nbar\nbaz");
  });

  test("throws multiple matches without replaceAll", () => {
    expect(() => EditMatcher.resolve("foo\nbar\nfoo", "foo")).toThrow(
      /matched multiple regions/
    );
  });

  test("not found includes closest regions above threshold", () => {
    const closest = EditMatcher.findClosestRegions(
      "alpha\nbeta\ngamma",
      "betx"
    );
    expect(closest[0]?.startLine).toBe(2);
    expect(closest[0]?.similarity).toBeGreaterThan(0.5);
  });

  test("not found returns no regions below threshold", () => {
    const closest = EditMatcher.findClosestRegions("aaaa\nbbbb", "zzzz");
    expect(closest).toEqual([]);
  });

  test("escape-drift guard rejects new escape sequences after fuzzy match", () => {
    const resolved = EditMatcher.resolve("  beta", "beta ");
    const range = "range" in resolved ? resolved.range : resolved.ranges[0]!;
    expect(() =>
      EditMatcher.assertNoEscapeDrift(
        resolved.strategy,
        "new\\nvalue",
        "  beta".slice(range[0], range[1])
      )
    ).toThrow(/newString contains literal escape text/);
  });
});
