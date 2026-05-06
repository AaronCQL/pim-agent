import { describe, expect, test } from "bun:test";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { DiffLines } from "../../shared/DiffLines";
import { countDiffStats, formatDiffStats } from "./render";

const stubTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
} as unknown as Theme;

describe("countDiffStats", () => {
  test("returns zeros when diff is undefined", () => {
    expect(countDiffStats(undefined)).toEqual({ added: 0, removed: 0 });
  });

  test("counts added and removed lines across hunks", () => {
    const diff = DiffLines.buildToolDiff(
      "/tmp/x.ts",
      ["alpha", "beta", "gamma", "delta"],
      ["alpha", "BETA", "gamma", "DELTA"],
      0
    );
    expect(countDiffStats(diff)).toEqual({ added: 2, removed: 2 });
  });

  test("counts a brand-new file as all added", () => {
    const diff = DiffLines.buildToolDiff(
      "/tmp/new.ts",
      [],
      ["one", "two", "three"],
      0
    );
    expect(countDiffStats(diff)).toEqual({ added: 3, removed: 0 });
  });
});

describe("formatDiffStats", () => {
  test("emits both segments separated by a slash", () => {
    expect(formatDiffStats({ added: 5, removed: 2 }, stubTheme)).toBe(
      "<toolDiffAdded>+5</toolDiffAdded>/<toolDiffRemoved>-2</toolDiffRemoved>"
    );
  });

  test("omits the removed segment when zero", () => {
    expect(formatDiffStats({ added: 5, removed: 0 }, stubTheme)).toBe(
      "<toolDiffAdded>+5</toolDiffAdded>"
    );
  });

  test("omits the added segment when zero", () => {
    expect(formatDiffStats({ added: 0, removed: 2 }, stubTheme)).toBe(
      "<toolDiffRemoved>-2</toolDiffRemoved>"
    );
  });

  test("returns empty string when both are zero", () => {
    expect(formatDiffStats({ added: 0, removed: 0 }, stubTheme)).toBe("");
  });
});
