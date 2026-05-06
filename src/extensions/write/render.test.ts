import { describe, expect, test } from "bun:test";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { DiffLines } from "../../shared/DiffLines";
import { DiffView } from "../../shared/DiffView";

const stubTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
} as unknown as Theme;

describe("DiffView.countStats", () => {
  test("returns zeros when diff is undefined", () => {
    expect(DiffView.countStats(undefined)).toEqual({ added: 0, removed: 0 });
  });

  test("counts added and removed lines across hunks", () => {
    const diff = DiffLines.buildToolDiff(
      "/tmp/x.ts",
      {
        lines: ["alpha", "beta", "gamma", "delta"],
        hasTrailingNewline: true,
      },
      {
        lines: ["alpha", "BETA", "gamma", "DELTA"],
        hasTrailingNewline: true,
      },
      0
    );
    expect(DiffView.countStats(diff)).toEqual({ added: 2, removed: 2 });
  });

  test("counts a brand-new file as all added", () => {
    const diff = DiffLines.buildToolDiff(
      "/tmp/new.ts",
      { lines: [], hasTrailingNewline: false },
      { lines: ["one", "two", "three"], hasTrailingNewline: true },
      0
    );
    expect(DiffView.countStats(diff)).toEqual({ added: 3, removed: 0 });
  });
});

describe("DiffView.formatStats", () => {
  test("emits both segments separated by a slash", () => {
    expect(DiffView.formatStats({ added: 5, removed: 2 }, stubTheme)).toBe(
      "<toolDiffAdded>+5</toolDiffAdded>/<toolDiffRemoved>-2</toolDiffRemoved>"
    );
  });

  test("omits the removed segment when zero", () => {
    expect(DiffView.formatStats({ added: 5, removed: 0 }, stubTheme)).toBe(
      "<toolDiffAdded>+5</toolDiffAdded>"
    );
  });

  test("omits the added segment when zero", () => {
    expect(DiffView.formatStats({ added: 0, removed: 2 }, stubTheme)).toBe(
      "<toolDiffRemoved>-2</toolDiffRemoved>"
    );
  });

  test("returns empty string when both are zero", () => {
    expect(DiffView.formatStats({ added: 0, removed: 0 }, stubTheme)).toBe("");
  });
});
