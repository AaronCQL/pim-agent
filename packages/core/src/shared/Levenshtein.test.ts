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
