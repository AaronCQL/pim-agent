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
  test("resolves exact matches", () => {
    expect(replace("alpha\nbeta\ngamma", "beta", "delta")).toBe(
      "alpha\ndelta\ngamma"
    );
  });

  test("uses lineTrimmed fallback", () => {
    expect(replace("alpha\n  beta\ngamma", "beta ", "delta")).toBe(
      "alpha\ndelta\ngamma"
    );
  });

  test("uses whitespaceNormalized fallback", () => {
    expect(replace("alpha\nfoo     bar\ngamma", "foo bar", "baz")).toBe(
      "alpha\nbaz\ngamma"
    );
  });

  test("uses indentationFlexible fallback", () => {
    const content = "root\n    if (ok) {\n      run()\n    }\nend";
    const oldString = "if (ok) {\n  run()\n}";
    expect(replace(content, oldString, "done()")).toBe("root\ndone()\nend");
  });

  test("uses escapeNormalized fallback", () => {
    expect(replace("alpha\nbeta\ngamma", "beta\\ngamma", "delta")).toBe(
      "alpha\ndelta"
    );
  });

  test("uses trimmedBoundary fallback", () => {
    expect(replace("alpha\nbeta\ngamma", "\n beta \n", "delta")).toBe(
      "alpha\ndelta\ngamma"
    );
  });

  test("uses unicodeNormalized fallback", () => {
    expect(replace("say “hello” now", 'say "hello" now', "done")).toBe("done");
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

  test("uses contextAware fallback", () => {
    const content = "start\nsame\nactual\nend";
    expect(replace(content, "start\nsame\nexpected\nend", "done")).toBe("done");
  });

  test("replaceAll returns every occurrence", () => {
    expect(replace("foo\nbar\nfoo", "foo", "baz", true)).toBe("baz\nbar\nbaz");
  });

  test("throws multiple matches without replaceAll", () => {
    expect(() => EditMatcher.resolve("foo\nbar\nfoo", "foo")).toThrow(
      /E_MULTIPLE_MATCHES/
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
    ).toThrow(/E_ESCAPE_DRIFT/);
  });
});
