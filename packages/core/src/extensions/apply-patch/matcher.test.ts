import { describe, expect, test } from "bun:test";
import { seekSequence } from "./matcher";

describe("seekSequence", () => {
  test("finds an exact sequence", () => {
    expect(seekSequence(["foo", "bar", "baz"], ["bar", "baz"], 0, false)).toBe(
      1
    );
  });

  test("ignores trailing whitespace", () => {
    expect(seekSequence(["foo   ", "bar\t"], ["foo", "bar"], 0, false)).toBe(0);
  });

  test("ignores leading and trailing whitespace", () => {
    expect(
      seekSequence(["    foo  ", "  bar\t"], ["foo", "bar"], 0, false)
    ).toBe(0);
  });

  test("returns undefined when pattern is longer than input", () => {
    expect(seekSequence(["one"], ["too", "many"], 0, false)).toBeUndefined();
  });

  test("empty pattern returns start", () => {
    expect(seekSequence(["a", "b"], [], 1, false)).toBe(1);
  });

  test("advances past the cursor for recurring context (multi-hunk)", () => {
    // The line `x = 1` recurs; a global-uniqueness matcher would be ambiguous.
    // Sequential cursor disambiguates: from cursor 0 we find the first, then
    // from cursor 2 we find the second.
    const lines = ["x = 1", "a", "x = 1", "b"];
    const first = seekSequence(lines, ["x = 1"], 0, false);
    expect(first).toBe(0);
    const second = seekSequence(lines, ["x = 1"], first! + 1, false);
    expect(second).toBe(2);
  });

  test("eof search starts flush against the end of file", () => {
    const lines = ["dup", "mid", "dup"];
    expect(seekSequence(lines, ["dup"], 0, true)).toBe(2);
  });
});
