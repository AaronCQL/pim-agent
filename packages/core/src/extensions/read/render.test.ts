import { describe, expect, test } from "bun:test";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { AnsiPainter } from "../../view/AnsiPainter";
import type { ToolView } from "../../view/ViewBlock";
import { readView, type ReadViewInput } from "./render";

/** What a call site hands the view: streamed args, and details a legacy session may have written untagged. */
type Case = {
  readonly args: Partial<ReadViewInput["args"]> | undefined;
  readonly result?: {
    readonly content: readonly {
      readonly type: string;
      readonly text: string;
    }[];
    readonly details?: Record<string, unknown>;
  };
  readonly cwd: string;
};

function view(input: Case): ToolView {
  return readView({
    args: input.args as ReadViewInput["args"],
    result: input.result as ReadViewInput["result"],
    cwd: input.cwd,
    isPartial: false,
  });
}

function tracingTheme(): {
  readonly theme: Theme;
  readonly calls: { readonly color: ThemeColor; readonly text: string }[];
} {
  const calls: { color: ThemeColor; text: string }[] = [];
  return {
    calls,
    theme: {
      fg: (color: ThemeColor, text: string) => {
        calls.push({ color, text });
        return `<${color}>${text}</${color}>`;
      },
    } as unknown as Theme,
  };
}

const cwd = "/work/repo";

function paintTitle(input: Case, theme: Theme = tracingTheme().theme): string {
  return AnsiPainter.paint(view(input).title, theme).join(" ");
}

function paintBody(input: Case): string {
  return AnsiPainter.paint(view(input).body ?? [], tracingTheme().theme).join(
    "\n"
  );
}

function settled(
  visibleStart: number,
  visibleEnd: number,
  body = ""
): Case["result"] {
  return {
    content: [{ type: "text", text: body }],
    details: { kind: "text", visibleStart, visibleEnd },
  };
}

function settledImage(overrides: Record<string, unknown> = {}): Case["result"] {
  return {
    content: [],
    details: {
      kind: "image",
      absolutePath: "/work/repo/docs/shot.png",
      sha256: "a".repeat(64),
      mimeType: "image/png",
      width: 2000,
      height: 500,
      bytes: 262144,
      resized: false,
      frames: 1,
      ...overrides,
    },
  };
}

describe("readView", () => {
  test("supplies the title-cased display label", () => {
    expect(view({ args: { path: "/work/repo/src/foo.ts" }, cwd }).label).toBe(
      "Read"
    );
  });
});

describe("readView title", () => {
  test("renders relative path without a range", () => {
    expect(paintTitle({ args: { path: "/work/repo/src/foo.ts" }, cwd })).toBe(
      "src/foo.ts"
    );
  });

  test("renders explicit start-end range", () => {
    expect(
      paintTitle({
        args: { path: "/work/repo/src/foo.ts", start: 40, end: 80 },
        cwd,
      })
    ).toBe("src/foo.ts<muted>:40-80</muted>");
  });

  test("defaults a missing start to line 1", () => {
    expect(
      paintTitle({ args: { path: "/work/repo/src/foo.ts", end: 80 }, cwd })
    ).toBe("src/foo.ts<muted>:1-80</muted>");
  });

  test("renders an open-ended start-only range, still muted", () => {
    const themed = tracingTheme();
    expect(
      paintTitle(
        { args: { path: "/work/repo/src/foo.ts", start: 40 }, cwd },
        themed.theme
      )
    ).toBe("src/foo.ts<muted>:40</muted>");
    expect(themed.calls).toEqual([{ color: "muted", text: ":40" }]);
  });

  test("falls back to absolute path when outside cwd", () => {
    expect(paintTitle({ args: { path: "/etc/hosts" }, cwd })).toBe(
      "/etc/hosts"
    );
  });

  test("placeholder when the path has not streamed in yet", () => {
    expect(paintTitle({ args: {}, cwd })).toBe("...");
    expect(paintTitle({ args: undefined, cwd })).toBe("...");
  });

  test("uses the visible range after execution even when none was requested", () => {
    expect(
      paintTitle({
        args: { path: "/work/repo/src/foo.ts" },
        result: settled(1, 7),
        cwd,
      })
    ).toBe("src/foo.ts<muted>:1-7</muted>");
  });

  test("uses the actual visible end instead of an overlarge requested end", () => {
    expect(
      paintTitle({
        args: { path: "/work/repo/src/foo.ts", start: 1, end: 999 },
        result: settled(1, 7),
        cwd,
      })
    ).toBe("src/foo.ts<muted>:1-7</muted>");
  });

  test("ignores details without a numeric visible range", () => {
    expect(
      paintTitle({
        args: { path: "/work/repo/src/foo.ts", start: 1, end: 9 },
        result: { content: [], details: { visibleStart: "1" } },
        cwd,
      })
    ).toBe("src/foo.ts<muted>:1-9</muted>");
  });

  test("mutes only the line range suffix", () => {
    const themed = tracingTheme();
    const title = paintTitle(
      {
        args: { path: "/work/repo/src/foo.ts" },
        result: settled(1, 7),
        cwd,
      },
      themed.theme
    );

    expect(title).toBe("src/foo.ts<muted>:1-7</muted>");
    expect(themed.calls).toEqual([{ color: "muted", text: ":1-7" }]);
  });
});

describe("readView body", () => {
  test("paints the first content block verbatim", () => {
    expect(
      paintBody({
        args: { path: "/work/repo/src/foo.ts" },
        result: settled(1, 2, "1:const a = 1;\n2:const b = 2;"),
        cwd,
      })
    ).toBe("1:const a = 1;\n2:const b = 2;");
  });

  test("ignores the continuation notice appended for the model", () => {
    expect(
      paintBody({
        args: { path: "/work/repo/src/foo.ts" },
        result: {
          content: [
            { type: "text", text: "1:alpha" },
            { type: "text", text: "[read tool: showing lines 1-1 of 9…]" },
          ],
          details: { visibleStart: 1, visibleEnd: 1 },
        },
        cwd,
      })
    ).toBe("1:alpha");
  });

  test("is empty while the call is in flight", () => {
    expect(paintBody({ args: { path: "/work/repo/src/foo.ts" }, cwd })).toBe(
      ""
    );
  });
});

describe("readView on an image", () => {
  test("drops the line range from the title", () => {
    expect(
      paintTitle({
        args: { path: "/work/repo/docs/shot.png", start: 1, end: 40 },
        result: settledImage(),
        cwd,
      })
    ).toBe("docs/shot.png");
  });

  test("addresses the cached picture and repeats its dimensions and size", () => {
    expect(
      paintBody({
        args: { path: "/work/repo/docs/shot.png" },
        result: settledImage(),
        cwd,
      })
    ).toBe(
      [
        "<muted>[image 2000×500 png · 256 KB]</muted>",
        "<muted>dimensions: </muted>2000x500",
        "<muted>size:       </muted>256 KB",
      ].join("\n")
    );
  });

  test("serves the picture under its post-resize extension, not the path's", () => {
    const [picture] = view({
      args: { path: "/work/repo/docs/shot.png" },
      result: settledImage({ mimeType: "image/jpeg", resized: true }),
      cwd,
    }).body!;

    expect(picture).toEqual({
      kind: "image",
      sha256: "a".repeat(64),
      mimeType: "image/jpeg",
      width: 2000,
      height: 500,
      bytes: 262144,
      alt: "docs/shot.png",
    });
  });

  test("says when the picture was downscaled to fit", () => {
    expect(
      paintBody({
        args: { path: "/work/repo/docs/shot.png" },
        result: settledImage({ resized: true }),
        cwd,
      })
    ).toContain("2000x500 (downscaled)");
  });

  test("still draws a deduped picture, and says it was not re-sent", () => {
    const body = paintBody({
      args: { path: "/work/repo/docs/shot.png" },
      result: settledImage({ deduped: true }),
      cwd,
    });

    expect(body).toContain("[image 2000×500 png · 256 KB]");
    expect(body).toContain(
      "<muted>reused:     </muted>unchanged since the earlier read"
    );
  });

  test("says how many frames the still left behind", () => {
    expect(
      paintBody({
        args: { path: "/work/repo/docs/shot.gif" },
        result: settledImage({ mimeType: "image/gif", frames: 24 }),
        cwd,
      })
    ).toContain("<muted>frames:     </muted>24 (frame 1 shown)");
  });
});
