import { describe, expect, test } from "bun:test";
import { seekSequenceMatches } from "./matcher";

describe("seekSequenceMatches", () => {
  test("finds an exact sequence", () => {
    expect(
      seekSequenceMatches(["foo", "bar", "baz"], ["bar", "baz"], 0, false)[0]
    ).toBe(1);
  });

  test("ignores trailing whitespace", () => {
    expect(
      seekSequenceMatches(["foo   ", "bar\t"], ["foo", "bar"], 0, false)[0]
    ).toBe(0);
  });

  test("ignores leading and trailing whitespace", () => {
    expect(
      seekSequenceMatches(["    foo  ", "  bar\t"], ["foo", "bar"], 0, false)[0]
    ).toBe(0);
  });

  test("returns undefined when pattern is longer than input", () => {
    expect(
      seekSequenceMatches(["one"], ["too", "many"], 0, false)[0]
    ).toBeUndefined();
  });

  test("empty pattern returns start", () => {
    expect(seekSequenceMatches(["a", "b"], [], 1, false)[0]).toBe(1);
  });

  test("advances past the cursor for recurring context (multi-hunk)", () => {
    // The line `x = 1` recurs; a global-uniqueness matcher would be ambiguous.
    // Sequential cursor disambiguates: from cursor 0 we find the first, then
    // from cursor 2 we find the second.
    const lines = ["x = 1", "a", "x = 1", "b"];
    const first = seekSequenceMatches(lines, ["x = 1"], 0, false)[0];
    expect(first).toBe(0);
    const second = seekSequenceMatches(lines, ["x = 1"], first! + 1, false)[0];
    expect(second).toBe(2);
  });

  test("eof search starts flush against the end of file", () => {
    const lines = ["dup", "mid", "dup"];
    expect(seekSequenceMatches(lines, ["dup"], 0, true)[0]).toBe(2);
  });
});
