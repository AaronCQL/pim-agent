import { describe, expect, test } from "bun:test";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { DiffLines, type ToolDiff } from "../shared/DiffLines";
import { AnsiPainter } from "./AnsiPainter";
import { DiffBlocks } from "./DiffBlocks";

const theme = {
  name: "dark",
  fg: (color: ThemeColor, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => text,
} as unknown as Theme;

const diff = (from: readonly string[], to: readonly string[]): ToolDiff =>
  DiffLines.buildToolDiff(
    "/repo/src/foo.ts",
    { lines: [...from], hasTrailingNewline: from.length > 0 },
    { lines: [...to], hasTrailingNewline: to.length > 0 },
    3
  ) as ToolDiff;

const paintStats = (d: ToolDiff | undefined): string =>
  AnsiPainter.paint(DiffBlocks.stats(d), theme).join(" ");

describe("DiffBlocks.stats", () => {
  test("emits both segments separated by an uncoloured slash", () => {
    expect(paintStats(diff(["a", "b"], ["A", "B"]))).toBe(
      "<toolDiffAdded>+2</toolDiffAdded>/<toolDiffRemoved>-2</toolDiffRemoved>"
    );
  });

  test("omits the removed segment when nothing was removed", () => {
    expect(paintStats(diff(["a"], ["a", "b"]))).toBe(
      "<toolDiffAdded>+1</toolDiffAdded>"
    );
  });

  test("omits the added segment when nothing was added", () => {
    expect(paintStats(diff(["a", "b"], ["a"]))).toBe(
      "<toolDiffRemoved>-1</toolDiffRemoved>"
    );
  });

  test("emits no block at all when there is nothing to count", () => {
    expect(DiffBlocks.stats(undefined)).toEqual([]);
    expect(DiffBlocks.stats({ path: "a.ts", hunks: [] })).toEqual([]);
  });
});

describe("DiffBlocks.body", () => {
  test("wraps a diff in a single diff block", () => {
    const toolDiff = diff(["a"], ["b"]);
    expect(DiffBlocks.body(toolDiff)).toEqual([
      { kind: "diff", path: toolDiff.path, hunks: toolDiff.hunks },
    ]);
  });

  test("is empty without a diff", () => {
    expect(DiffBlocks.body(undefined)).toEqual([]);
  });
});

describe("DiffBlocks.fileView", () => {
  const view = (path: string | undefined, d?: ToolDiff) =>
    DiffBlocks.fileView({ label: "Edit", path, cwd: "/repo", diff: d });

  test("titles the row with the cwd-relative path plus stats", () => {
    expect(
      AnsiPainter.paint(
        view("/repo/src/foo.ts", diff(["a"], ["b"])).title,
        theme
      ).join(" ")
    ).toBe(
      "src/foo.ts <toolDiffAdded>+1</toolDiffAdded>/<toolDiffRemoved>-1</toolDiffRemoved>"
    );
  });

  test("falls back to a placeholder before the path streams in", () => {
    expect(AnsiPainter.paint(view(undefined).title, theme)).toEqual(["..."]);
  });
});
