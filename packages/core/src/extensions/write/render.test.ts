import { describe, expect, test } from "bun:test";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { DiffLines, type ToolDiff } from "../../shared/DiffLines";
import { DiffRenderer } from "../../shared/DiffRenderer";
import { AnsiPainter } from "../../view/AnsiPainter";
import { writeView } from "./render";
import type { WriteOutcome } from "./write";

const theme = {
  name: "dark",
  fg: (color: ThemeColor, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => text,
} as unknown as Theme;

const cwd = "/work/repo";

const diff = (from: readonly string[], to: readonly string[]): ToolDiff =>
  DiffLines.buildToolDiff(
    "/work/repo/src/foo.ts",
    { lines: [...from], hasTrailingNewline: from.length > 0 },
    { lines: [...to], hasTrailingNewline: true },
    3
  ) as ToolDiff;

const settled = (
  details: Partial<WriteOutcome>
): { readonly content: []; readonly details: WriteOutcome } => ({
  content: [],
  details: { bytesWritten: 0, created: false, ...details },
});

function paintTitle(
  args: Record<string, unknown> | undefined,
  result?: ReturnType<typeof settled>
): string {
  return AnsiPainter.paint(
    writeView({ args: args as never, result, cwd, isPartial: false }).title,
    theme
  ).join(" ");
}

function paintBody(
  args: Record<string, unknown> | undefined,
  result?: ReturnType<typeof settled>
): string[] {
  return AnsiPainter.paint(
    writeView({ args: args as never, result, cwd, isPartial: false }).body ??
      [],
    theme
  );
}

describe("writeView title", () => {
  test("placeholder while the path has not streamed in", () => {
    expect(paintTitle({})).toBe("...");
    expect(paintTitle(undefined)).toBe("...");
    expect(paintTitle({ path: 12 })).toBe("...");
  });

  test("appends both coloured diff stats once the result settles", () => {
    expect(
      paintTitle(
        { path: "/work/repo/src/foo.ts" },
        settled({ diff: diff(["a", "b"], ["a", "B"]) })
      )
    ).toBe(
      "src/foo.ts <toolDiffAdded>+1</toolDiffAdded>/<toolDiffRemoved>-1</toolDiffRemoved>"
    );
  });

  test("stays bare for an unchanged write", () => {
    expect(paintTitle({ path: "/work/repo/src/foo.ts" }, settled({}))).toBe(
      "src/foo.ts"
    );
  });
});

describe("writeView body", () => {
  test("is byte-identical to the legacy DiffRenderer output", () => {
    const toolDiff = diff(["a", "b", "c"], ["a", "B", "c"]);
    expect(
      paintBody({ path: "/work/repo/src/foo.ts" }, settled({ diff: toolDiff }))
    ).toEqual(DiffRenderer.render({ toolDiff, theme }).split("\n"));
  });

  test("is empty while the call is in flight", () => {
    expect(paintBody({ path: "/work/repo/src/foo.ts" })).toEqual([]);
  });
});
