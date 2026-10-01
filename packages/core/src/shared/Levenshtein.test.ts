import { describe, expect, test } from "bun:test";
import { Levenshtein } from "./Levenshtein";

describe("Levenshtein.distance", () => {
  test.each([
    ["abc", "abc", 0],
    ["", "", 0],
    ["", "abc", 3],
    ["abc", "", 3],
    ["ab", "abc", 1],
    ["abc", "ab", 1],
    ["abc", "axc", 1],
    ["kitten", "sitting", 3],
    ["abcde", "edcba", 4],
    ["intention", "execution", 5],
    ["café", "cafè", 1],
  ])("%p → %p is %p", (left, right, expected) => {
    expect(Levenshtein.distance(left, right)).toBe(expected);
  });
});

describe("Levenshtein.damerau", () => {
  test("a transposition is one edit, where plain Levenshtein counts two", () => {
    expect(Levenshtein.damerau("teh", "the", 2)).toBe(1);
    expect(Levenshtein.distance("teh", "the")).toBe(2);
    expect(Levenshtein.damerau("gatewya", "gateway", 1)).toBe(1);
  });

  test("agrees with plain Levenshtein on everything else", () => {
    expect(Levenshtein.damerau("sidbar", "sidebar", 2)).toBe(1);
    expect(Levenshtein.damerau("kitten", "sitting", 3)).toBe(3);
    expect(Levenshtein.damerau("abc", "abc", 0)).toBe(0);
  });

  test("a pair further apart than the ceiling answers max + 1", () => {
    expect(Levenshtein.damerau("kitten", "sitting", 1)).toBe(2);
    expect(Levenshtein.damerau("lease", "telegram", 2)).toBe(3);
    expect(Levenshtein.damerau("", "abc", 2)).toBe(3);
  });
});
