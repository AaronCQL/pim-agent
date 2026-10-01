import { describe, expect, test } from "bun:test";
import { clampNumResults, formatResults } from "./search";

test.each([
  [undefined, 5],
  [25, 10],
  [0, 1],
  [3, 3],
])("clampNumResults(%p) is %p", (value, expected) => {
  expect(clampNumResults(value)).toBe(expected);
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
});
