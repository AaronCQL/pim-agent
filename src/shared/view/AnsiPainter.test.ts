import { describe, expect, test } from "bun:test";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { DiffLines } from "../DiffLines";
import { DiffRenderer } from "../DiffRenderer";
import { AnsiPainter } from "./AnsiPainter";
import type { ViewBlock } from "./ViewBlock";

const theme = {
  bold: (text: string) => text,
  fg: (color: ThemeColor, text: string) => `<${color}>${text}</${color}>`,
} as unknown as Theme;

function paint(...blocks: readonly ViewBlock[]): string[] {
  return AnsiPainter.paint(blocks, theme);
}

describe("AnsiPainter text", () => {
  test("default tone is uncolored and splits on newlines", () => {
    expect(paint({ kind: "text", text: "one\ntwo" })).toEqual(["one", "two"]);
  });

  test("muted and error tones color each line", () => {
    expect(paint({ kind: "text", text: "a", tone: "muted" })).toEqual([
      "<muted>a</muted>",
    ]);
    expect(paint({ kind: "text", text: "a\nb", tone: "error" })).toEqual([
      "<error>a</error>",
      "<error>b</error>",
    ]);
  });
});

describe("AnsiPainter code", () => {
  test("emits raw lines without a gutter", () => {
    expect(paint({ kind: "code", lang: "ts", text: "const a = 1;" })).toEqual([
      "const a = 1;",
    ]);
  });

  test("right-aligns the line-number gutter", () => {
    expect(
      paint({ kind: "code", lang: "ts", text: "a\nb", startLine: 9 })
    ).toEqual(["<muted> 9 </muted>a", "<muted>10 </muted>b"]);
  });
});

describe("AnsiPainter diff", () => {
  test("delegates to the existing DiffRenderer", () => {
    const diff = DiffLines.buildToolDiff(
      "notes.txt",
      { lines: ["a", "b"], hasTrailingNewline: true },
      { lines: ["a", "c"], hasTrailingNewline: true },
      1
    );
    if (diff === undefined) {
      throw new Error("expected a diff");
    }

    expect(paint({ kind: "diff", ...diff })).toEqual(
      DiffRenderer.render({ toolDiff: diff, theme }).split("\n")
    );
  });

  test("paints nothing when there are no hunks", () => {
    expect(paint({ kind: "diff", path: "notes.txt", hunks: [] })).toEqual([]);
  });
});

describe("AnsiPainter file", () => {
  test("bare path has no styled suffix", () => {
    expect(paint({ kind: "file", path: "src/foo.ts" })).toEqual(["src/foo.ts"]);
  });

  test("range and truncation render muted, matching the read title", () => {
    expect(paint({ kind: "file", path: "src/foo.ts", range: [1, 7] })).toEqual([
      "src/foo.ts<muted>:1-7</muted>",
    ]);
    expect(
      paint({
        kind: "file",
        path: "src/foo.ts",
        range: [1, 7],
        truncated: true,
      })
    ).toEqual(["src/foo.ts<muted>:1-7 (truncated)</muted>"]);
  });

  test("an undefined range end renders open-ended and still muted", () => {
    expect(
      paint({ kind: "file", path: "src/foo.ts", range: [40, undefined] })
    ).toEqual(["src/foo.ts<muted>:40</muted>"]);
    expect(
      paint({
        kind: "file",
        path: "src/foo.ts",
        range: [40, undefined],
        truncated: true,
      })
    ).toEqual(["src/foo.ts<muted>:40 (truncated)</muted>"]);
  });
});

describe("AnsiPainter list", () => {
  test("bullets unordered items", () => {
    expect(
      paint({
        kind: "list",
        items: [
          { kind: "text", text: "a" },
          { kind: "text", text: "b" },
        ],
      })
    ).toEqual(["<muted>• </muted>a", "<muted>• </muted>b"]);
  });

  test("numbers ordered items and aligns wider markers", () => {
    const items: ViewBlock[] = Array.from({ length: 10 }, (_, index) => ({
      kind: "text",
      text: `item${index + 1}`,
    }));
    const lines = paint({ kind: "list", items, ordered: true });

    expect(lines[0]).toBe("<muted>1.  </muted>item1");
    expect(lines[9]).toBe("<muted>10. </muted>item10");
  });

  test("indents continuation lines under the marker", () => {
    expect(
      paint({ kind: "list", items: [{ kind: "text", text: "a\nb" }] })
    ).toEqual(["<muted>• </muted>a", "  b"]);
  });

  test("recurses into nested lists", () => {
    expect(
      paint({
        kind: "list",
        items: [
          { kind: "text", text: "outer" },
          {
            kind: "list",
            items: [
              { kind: "text", text: "inner1" },
              { kind: "text", text: "inner2" },
            ],
          },
        ],
      })
    ).toEqual([
      "<muted>• </muted>outer",
      "<muted>• </muted><muted>• </muted>inner1",
      "  <muted>• </muted>inner2",
    ]);
  });

  test("empty list paints nothing", () => {
    expect(paint({ kind: "list", items: [] })).toEqual([]);
  });
});

describe("AnsiPainter kv", () => {
  test("aligns values past the widest key", () => {
    expect(
      paint({
        kind: "kv",
        pairs: [
          ["exit", "1"],
          ["signal", "SIGKILL"],
        ],
      })
    ).toEqual(["<muted>exit:   </muted>1", "<muted>signal: </muted>SIGKILL"]);
  });
});

describe("AnsiPainter link", () => {
  test("renders label and href separately", () => {
    expect(paint({ kind: "link", href: "https://x.dev", label: "X" })).toEqual([
      "<mdLink>X</mdLink> <mdLinkUrl>https://x.dev</mdLinkUrl>",
    ]);
  });

  test("collapses a label that repeats the href", () => {
    expect(
      paint({ kind: "link", href: "https://x.dev", label: "https://x.dev" })
    ).toEqual(["<mdLinkUrl>https://x.dev</mdLinkUrl>"]);
  });
});

describe("AnsiPainter notice", () => {
  test("maps severity to theme colors", () => {
    expect(
      paint(
        { kind: "notice", text: "i", severity: "info" },
        { kind: "notice", text: "w", severity: "warn" },
        { kind: "notice", text: "e", severity: "error" }
      )
    ).toEqual(["<muted>i</muted>", "<warning>w</warning>", "<error>e</error>"]);
  });
});

describe("AnsiPainter.paint", () => {
  test("concatenates blocks in order", () => {
    expect(
      paint(
        { kind: "file", path: "a.ts" },
        { kind: "text", text: "x\ny" },
        { kind: "notice", text: "z", severity: "warn" }
      )
    ).toEqual(["a.ts", "x", "y", "<warning>z</warning>"]);
  });

  test("no blocks paints no lines", () => {
    expect(AnsiPainter.paint([], theme)).toEqual([]);
  });
});
