import { describe, expect, test } from "bun:test";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { DiffLines, type ToolDiff } from "../../shared/DiffLines";
import { DiffRenderer } from "../../shared/DiffRenderer";
import { AnsiPainter } from "../../shared/view/AnsiPainter";
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
    warnings: [],
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
  test("supplies the title-cased display label", () => {
    expect(
      editView({ args: { path: "a.ts" } as never, cwd, isPartial: false }).label
    ).toBe("Edit");
  });

  test("forces the diff body open regardless of expansion", () => {
    expect(
      editView({ args: { path: "a.ts" } as never, cwd, isPartial: false })
        .collapsed
    ).toBe(false);
  });
});

describe("editView title", () => {
  test("renders the path relative to cwd", () => {
    expect(paintTitle({ path: "/work/repo/src/foo.ts" })).toBe("src/foo.ts");
  });

  test("keeps an absolute path when outside cwd", () => {
    expect(paintTitle({ path: "/etc/hosts" })).toBe("/etc/hosts");
  });

  test("placeholder while the path has not streamed in", () => {
    expect(paintTitle({})).toBe("...");
    expect(paintTitle(undefined)).toBe("...");
    expect(paintTitle({ path: 12 })).toBe("...");
  });

  test("appends coloured diff stats once the result settles", () => {
    expect(
      paintTitle(
        { path: "/work/repo/src/foo.ts" },
        settled({ diff: diff(["a", "b"], ["a", "B"]) })
      )
    ).toBe(
      "src/foo.ts <toolDiffAdded>+1</toolDiffAdded>/<toolDiffRemoved>-1</toolDiffRemoved>"
    );
  });

  test("stays bare when the outcome carries no diff", () => {
    expect(paintTitle({ path: "/work/repo/src/foo.ts" }, settled({}))).toBe(
      "src/foo.ts"
    );
  });
});

describe("editView body", () => {
  test("is byte-identical to the legacy DiffRenderer output", () => {
    const toolDiff = diff(["a", "b", "c"], ["a", "B", "c"]);
    expect(
      paintBody({ path: "/work/repo/src/foo.ts" }, settled({ diff: toolDiff }))
    ).toEqual(DiffRenderer.render({ toolDiff, theme }).split("\n"));
  });

  test("is empty while the call is in flight", () => {
    expect(paintBody({ path: "/work/repo/src/foo.ts" })).toEqual([]);
  });

  test("is empty when the outcome carries no diff", () => {
    expect(paintBody({ path: "/work/repo/src/foo.ts" }, settled({}))).toEqual(
      []
    );
  });
});
