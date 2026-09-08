import { describe, expect, test } from "bun:test";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { DiffLines } from "../shared/DiffLines";
import { DiffRenderer } from "../shared/DiffRenderer";
import { AnsiPainter } from "./AnsiPainter";
import type { ViewBlock } from "./ViewBlock";

const theme = {
  bold: (text: string) => `<b>${text}</b>`,
  fg: (color: ThemeColor, text: string) => `<${color}>${text}</${color}>`,
  strikethrough: (text: string) => `<s>${text}</s>`,
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

describe("AnsiPainter spans", () => {
  test("joins runs with no separator and leaves default tone bare", () => {
    expect(
      paint({
        kind: "spans",
        spans: [
          { text: "+2", tone: "added" },
          { text: "/" },
          { text: "-1", tone: "removed" },
        ],
      })
    ).toEqual([
      "<toolDiffAdded>+2</toolDiffAdded>/<toolDiffRemoved>-1</toolDiffRemoved>",
    ]);
  });

  test("applies the decoration inside the tone wrapper", () => {
    expect(
      paint({
        kind: "spans",
        spans: [{ text: "old", tone: "dim", strike: true }],
      })
    ).toEqual(["<dim><s>old</s></dim>"]);
  });

  test("an empty span contributes nothing, not an empty wrapper", () => {
    expect(
      paint({
        kind: "spans",
        spans: [{ text: "", tone: "title" }, { text: "a" }],
      })
    ).toEqual(["a"]);
  });

  test("maps every tone", () => {
    expect(
      paint({
        kind: "spans",
        spans: [
          { text: "a", tone: "default" },
          { text: "b", tone: "muted" },
          { text: "c", tone: "dim" },
          { text: "d", tone: "error" },
          { text: "e", tone: "added" },
          { text: "f", tone: "removed" },
          { text: "g", tone: "title" },
          { text: "h", tone: "warning" },
          { text: "i", tone: "accent" },
        ],
      })
    ).toEqual([
      "a<muted>b</muted><dim>c</dim><error>d</error>" +
        "<toolDiffAdded>e</toolDiffAdded><toolDiffRemoved>f</toolDiffRemoved>" +
        "<toolTitle>g</toolTitle><warning>h</warning><accent>i</accent>",
    ]);
  });
});

describe("AnsiPainter section", () => {
  test("paints a separator plus a marked, bold-labelled heading", () => {
    expect(
      paint({
        kind: "section",
        label: "Write",
        content: [
          {
            kind: "spans",
            spans: [{ text: "b.txt " }, { text: "+2", tone: "added" }],
          },
        ],
      })
    ).toEqual([
      "",
      "<success> ▪</success> <toolTitle><b>Write</b></toolTitle>" +
        "<toolTitle>: b.txt <toolDiffAdded>+2</toolDiffAdded></toolTitle>",
    ]);
  });
});

describe("AnsiPainter.paintBody", () => {
  test("runs adjacent same-frame blocks together", () => {
    const groups = AnsiPainter.paintBody(
      [
        { kind: "file", path: "a.ts" },
        { kind: "text", text: "note" },
        { kind: "diff", path: "a.ts", hunks: [] },
      ],
      theme
    );

    expect(groups).toEqual([
      { frame: "flow", lines: ["a.ts", "note"] },
      { frame: "tight", lines: [] },
    ]);
  });

  test("defers markdown unpainted and breaks the run around it", () => {
    const groups = AnsiPainter.paintBody(
      [
        { kind: "text", text: "one" },
        { kind: "markdown", text: "**bold**" },
        { kind: "text", text: "two" },
      ],
      theme
    );

    expect(groups).toEqual([
      { frame: "flow", lines: ["one"] },
      { frame: "embed", markdown: "**bold**" },
      { frame: "flow", lines: ["two"] },
    ]);
  });

  test("breaks a run on a heading and reopens after it", () => {
    const groups = AnsiPainter.paintBody(
      [
        { kind: "text", text: "one" },
        {
          kind: "section",
          label: "Edit",
          content: [{ kind: "spans", spans: [{ text: "b.ts" }] }],
        },
        { kind: "text", text: "two" },
      ],
      theme
    );

    expect(groups.map((group) => group.frame)).toEqual([
      "flow",
      "heading",
      "flow",
    ]);
    const heading = groups[1];
    expect(heading && "lines" in heading ? heading.lines[0] : undefined).toBe(
      ""
    );
  });

  test("no blocks produce no groups", () => {
    expect(AnsiPainter.paintBody([], theme)).toEqual([]);
  });
});

describe("AnsiPainter.paintTitle", () => {
  test("joins painted blocks with a space", () => {
    expect(
      AnsiPainter.paintTitle(
        [
          { kind: "text", text: "a.ts" },
          { kind: "text", text: "(2 lines)", tone: "muted" },
        ],
        theme
      )
    ).toEqual({ text: "a.ts <muted>(2 lines)</muted>", markdown: false });
  });

  test("hands a lone markdown block over unpainted", () => {
    expect(
      AnsiPainter.paintTitle([{ kind: "markdown", text: "a **b**" }], theme)
    ).toEqual({ text: "a **b**", markdown: true });
  });
});

describe("AnsiPainter.themeColorFor", () => {
  test("maps tones and leaves the default colour alone", () => {
    expect(AnsiPainter.themeColorFor("accent")).toBe("accent");
    expect(AnsiPainter.themeColorFor("title")).toBe("toolTitle");
    expect(AnsiPainter.themeColorFor("default")).toBeUndefined();
    expect(AnsiPainter.themeColorFor(undefined)).toBeUndefined();
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

// A URL relative to a web gateway this terminal is not talking to says
// nothing here, and the bytes behind it are a copy of a file already on this
// machine: the delivery is the news, the address of it is not.
describe("AnsiPainter attachment", () => {
  test("names the file and drops the url", () => {
    expect(
      paint({
        kind: "attachment",
        name: "revenue.png",
        url: "/attachment/s1/revenue-1.png",
        isImage: true,
      })
    ).toEqual(["<muted>sent</muted> revenue.png"]);
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
