import { describe, expect, test } from "bun:test";
import { Levenshtein } from "./Levenshtein";

describe("Levenshtein.distance", () => {
  test("identical strings have distance 0", () => {
    expect(Levenshtein.distance("abc", "abc")).toBe(0);
  });

  test("empty strings have distance 0", () => {
    expect(Levenshtein.distance("", "")).toBe(0);
  });

  test("empty string distance equals length of the other", () => {
    expect(Levenshtein.distance("", "abc")).toBe(3);
    expect(Levenshtein.distance("abc", "")).toBe(3);
  });

  test("single-character insertion", () => {
    expect(Levenshtein.distance("ab", "abc")).toBe(1);
  });

  test("single-character deletion", () => {
    expect(Levenshtein.distance("abc", "ab")).toBe(1);
  });

  test("single-character substitution", () => {
    expect(Levenshtein.distance("abc", "axc")).toBe(1);
  });

  test("multiple operations", () => {
    expect(Levenshtein.distance("kitten", "sitting")).toBe(3);
  });

  test("no-op: same string via identity check", () => {
    const s = "hello world";
    expect(Levenshtein.distance(s, s)).toBe(0);
  });

  test("reverse strings", () => {
    expect(Levenshtein.distance("abcde", "edcba")).toBe(4);
  });

  test("longer strings with small edit distance", () => {
    expect(Levenshtein.distance("intention", "execution")).toBe(5);
  });

  test("unicode characters", () => {
    expect(Levenshtein.distance("café", "cafè")).toBe(1);
  });

  test("same length, all different", () => {
    expect(Levenshtein.distance("abc", "xyz")).toBe(3);
  });

  test("one is prefix of other", () => {
    expect(Levenshtein.distance("abc", "abcd")).toBe(1);
  });

  test("asymmetric length with shared prefix", () => {
    expect(Levenshtein.distance("abc", "abcxyz")).toBe(3);
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

  test("a pair further apart than the ceiling answers just past it", () => {
    expect(Levenshtein.damerau("kitten", "sitting", 1)).toBe(2);
    expect(Levenshtein.damerau("lease", "telegram", 2)).toBe(3);
    expect(Levenshtein.damerau("", "abc", 2)).toBe(3);
  });
});
