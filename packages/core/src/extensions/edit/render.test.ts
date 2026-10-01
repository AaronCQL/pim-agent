import { describe, expect, test } from "bun:test";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { DiffLines, type ToolDiff } from "../../shared/DiffLines";
import { DiffRenderer } from "../../shared/DiffRenderer";
import { AnsiPainter } from "../../view/AnsiPainter";
import type { EditOutcome } from "./edit";
import { editView } from "./render";

const theme = {
  name: "dark",
  fg: (color: ThemeColor, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => text,
} as unknown as Theme;

const cwd = "/work/repo";

const diff = (from: readonly string[], to: readonly string[]): ToolDiff =>
  DiffLines.buildToolDiff(
    "/work/repo/src/foo.ts",
    { lines: [...from], hasTrailingNewline: true },
    { lines: [...to], hasTrailingNewline: true },
    2
  ) as ToolDiff;

const settled = (
  details: Partial<EditOutcome>
): { readonly content: []; readonly details: EditOutcome } => ({
  content: [],
  details: {
    editCount: 1,
    noops: [],
    ranges: [],
    resolvedEdits: [],
    ...details,
  },
});

function paintTitle(
  args: Record<string, unknown> | undefined,
  result?: ReturnType<typeof settled>
): string {
  return AnsiPainter.paint(
    editView({ args: args as never, result, cwd, isPartial: false }).title,
    theme
  ).join(" ");
}

function paintBody(
  args: Record<string, unknown> | undefined,
  result?: ReturnType<typeof settled>
): string[] {
  return AnsiPainter.paint(
    editView({ args: args as never, result, cwd, isPartial: false }).body ?? [],
    theme
  );
}

describe("editView", () => {
  test("placeholder for a non-string path", () => {
    expect(paintTitle({ path: 12 })).toBe("...");
  });

  test("titles the row with the relative path and diff stats", () => {
    expect(
      paintTitle(
        { path: "/work/repo/src/foo.ts" },
        settled({ diff: diff(["a", "b"], ["a", "B"]) })
      )
    ).toBe(
      "src/foo.ts <toolDiffAdded>+1</toolDiffAdded>/<toolDiffRemoved>-1</toolDiffRemoved>"
    );
  });

  test("body matches DiffRenderer output", () => {
    const toolDiff = diff(["a", "b", "c"], ["a", "B", "c"]);
    expect(
      paintBody({ path: "/work/repo/src/foo.ts" }, settled({ diff: toolDiff }))
    ).toEqual(DiffRenderer.render({ toolDiff, theme }).split("\n"));
  });
});
