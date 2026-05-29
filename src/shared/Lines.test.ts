import { describe, expect, test } from "bun:test";
import { Lines } from "./Lines";

describe("Lines.continuationLine", () => {
  test("resumes on the partial last line when the cut is mid-line", () => {
    expect(Lines.continuationLine("a\nb\nc")).toBe(3);
  });

  test("resumes on the next line when the cut lands on a newline", () => {
    expect(Lines.continuationLine("a\nb\n")).toBe(3);
  });

  test("treats a single unterminated line as line 1", () => {
    expect(Lines.continuationLine("a")).toBe(1);
  });

  test("never returns below 1 for empty input", () => {
    expect(Lines.continuationLine("")).toBe(1);
  });

  test("counts normalized newlines (CRLF and CR)", () => {
    expect(Lines.continuationLine("a\r\nb\r\nc")).toBe(3);
    expect(Lines.continuationLine("a\rb")).toBe(2);
  });
});
