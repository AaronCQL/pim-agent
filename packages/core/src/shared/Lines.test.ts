import { describe, expect, test } from "bun:test";
import { Lines } from "./Lines";

describe("Lines.continuationLine", () => {
  test.each([
    ["a\nb\nc", 3],
    ["a\nb\n", 3],
    ["a", 1],
    ["", 1],
    ["a\r\nb\r\nc", 3],
    ["a\rb", 2],
  ])("%p resumes on line %p", (head, expected) => {
    expect(Lines.continuationLine(head)).toBe(expected);
  });
});
