import { describe, expect, test } from "bun:test";
import { clampNumResults, formatResults } from "./search";

describe("clampNumResults", () => {
  test("defaults when undefined", () => {
    expect(clampNumResults(undefined)).toBe(5);
  });

  test("clamps above maximum", () => {
    expect(clampNumResults(25)).toBe(10);
  });

  test("clamps below minimum", () => {
    expect(clampNumResults(0)).toBe(1);
  });

  test("passes through valid values", () => {
    expect(clampNumResults(3)).toBe(3);
  });
});

describe("formatResults", () => {
  test("renders results as deterministic plain text", () => {
    expect(
      formatResults([
        {
          title: "First",
          url: "https://example.test/first",
          snippet: "First snippet.",
        },
        {
          title: "Second",
          url: "https://example.test/second",
          snippet: "Second snippet.",
        },
      ])
    ).toBe(
      [
        "title: First",
        "url: https://example.test/first",
        "snippet: First snippet.",
        "",
        "title: Second",
        "url: https://example.test/second",
        "snippet: Second snippet.",
      ].join("\n")
    );
  });

  test("returns empty string for empty input", () => {
    expect(formatResults([])).toBe("");
  });
});
