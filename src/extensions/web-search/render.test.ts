import { describe, expect, test } from "bun:test";
import { DEFAULT_NUM_RESULTS } from "./schema";
import { formatTitle } from "./render";

describe("formatTitle", () => {
  test("always includes the default count in parentheses", () => {
    expect(formatTitle("bun release notes", undefined)).toBe(
      `bun release notes (${DEFAULT_NUM_RESULTS})`
    );
  });

  test("includes explicit counts in parentheses", () => {
    expect(formatTitle("pi agent", 3)).toBe("pi agent (3)");
  });

  test("names the provider once it is known", () => {
    expect(formatTitle("pi agent", 3, "firecrawl")).toBe(
      "pi agent (3 · firecrawl)"
    );
  });

  test("uses a placeholder while keeping the count visible", () => {
    expect(formatTitle(undefined, undefined)).toBe(
      `... (${DEFAULT_NUM_RESULTS})`
    );
  });
});
