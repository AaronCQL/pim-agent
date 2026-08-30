import { describe, expect, test } from "bun:test";
import { MarkdownPainter } from "./MarkdownPainter";
import type { ToolView, ViewBlock } from "./ViewBlock";

const paint = (block: ViewBlock): readonly string[] =>
  MarkdownPainter.paint([block]);

const inline = (block: ViewBlock): string =>
  MarkdownPainter.paintInline([block]);

describe("MarkdownPainter text", () => {
  test("escapes html and keeps one line per source line", () => {
    expect(paint({ kind: "text", text: 'a <b> & "c"\nsecond' })).toEqual([
      "a &lt;b&gt; &amp; &quot;c&quot;",
      "second",
    ]);
  });

  test("leaves tones unstyled but shouts an error tone", () => {
    expect(paint({ kind: "text", text: "hush", tone: "muted" })).toEqual([
      "hush",
    ]);
    expect(paint({ kind: "text", text: "boom", tone: "error" })).toEqual([
      "<b>boom</b>",
    ]);
  });

  test("collapses to the first line inline", () => {
    expect(inline({ kind: "text", text: "head  \ntail" })).toBe("head …");
  });

  test("caps an overlong inline run", () => {
    const painted = inline({ kind: "text", text: "x".repeat(300) });
    expect(painted).toHaveLength(180);
    expect(painted.endsWith("…")).toBe(true);
  });
});

describe("MarkdownPainter spans", () => {
  test("wraps code, strike and strong, and escapes each run", () => {
    expect(
      paint({
        kind: "spans",
        spans: [
          { text: "ls <x>", code: true },
          { text: " " },
          { text: "old", strike: true },
          { text: "new", strong: true },
          { text: "", code: true },
        ],
      })
    ).toEqual(["<code>ls &lt;x&gt;</code> <s>old</s><b>new</b>"]);
  });
});

describe("MarkdownPainter markdown", () => {
  test("escapes the source instead of re-rendering it", () => {
    expect(paint({ kind: "markdown", text: "**bold** <i>\nrest" })).toEqual([
      "**bold** &lt;i&gt;",
      "rest",
    ]);
  });
});

describe("MarkdownPainter section", () => {
  test("leads with the icon when it has one", () => {
    expect(
      paint({
        kind: "section",
        label: "Delete",
        icon: "trash",
        content: [{ kind: "file", path: "src/old.ts" }],
      })
    ).toEqual(["🗑️ <code>old.ts</code>"]);
  });

  test("falls back to a bold label without an icon", () => {
    expect(
      paint({
        kind: "section",
        label: "Edit <2>",
        content: [{ kind: "spans", spans: [{ text: "b.ts" }] }],
      })
    ).toEqual(["<b>Edit &lt;2&gt;</b> b.ts"]);
  });

  test("is a lone lead when it has no content", () => {
    expect(paint({ kind: "section", label: "Notes", content: [] })).toEqual([
      "<b>Notes</b>",
    ]);
  });
});

describe("MarkdownPainter code", () => {
  test("fences with the language and numbers lines when asked", () => {
    expect(
      paint({ kind: "code", lang: "ts", text: "a\nb", startLine: 9 })
    ).toEqual(['<pre><code class="language-ts"> 9 a\n10 b</code></pre>']);
  });

  test("fences bare code without a language", () => {
    expect(paint({ kind: "code", lang: "", text: "x < y" })).toEqual([
      "<pre>x &lt; y</pre>",
    ]);
  });

  test("shrinks to an inline code span", () => {
    expect(inline({ kind: "code", lang: "sh", text: "one\ntwo" })).toBe(
      "<code>one …</code>"
    );
  });
});

describe("MarkdownPainter diff", () => {
  const block: ViewBlock = {
    kind: "diff",
    path: "a.ts",
    hunks: [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        lines: [
          { kind: "context", text: "keep" },
          { kind: "removed", text: "gone <x>" },
          { kind: "added", text: "new" },
        ],
      },
    ],
  };

  test("renders unified hunks in a diff fence", () => {
    expect(paint(block)).toEqual([
      '<pre><code class="language-diff">@@ -1,2 +1,2 @@\n keep\n-gone &lt;x&gt;\n+new</code></pre>',
    ]);
  });

  test("shows only the hunk header inline", () => {
    expect(inline(block)).toBe("<code>@@ -1,2 +1,2 @@</code>");
  });

  test("paints nothing for an empty diff", () => {
    expect(paint({ kind: "diff", path: "a.ts", hunks: [] })).toEqual([]);
  });
});

describe("MarkdownPainter file", () => {
  test("keeps the whole path in a body", () => {
    expect(paint({ kind: "file", path: "src/deep/a.ts" })).toEqual([
      "<code>src/deep/a.ts</code>",
    ]);
  });

  test("shrinks to the basename inline, with range and truncation", () => {
    expect(
      inline({
        kind: "file",
        path: "src/deep/a.ts",
        range: [1, 40],
        truncated: true,
      })
    ).toBe("<code>a.ts:1-40</code> (truncated)");
  });

  test("marks an open-ended range", () => {
    expect(inline({ kind: "file", path: "a.ts", range: [12, undefined] })).toBe(
      "<code>a.ts:12</code>"
    );
  });
});

describe("MarkdownPainter list", () => {
  test("bullets items and indents their continuations", () => {
    expect(
      paint({
        kind: "list",
        items: [
          { kind: "text", text: "one\nwrapped" },
          { kind: "file", path: "a.ts" },
        ],
      })
    ).toEqual(["• one", "  wrapped", "• <code>a.ts</code>"]);
  });

  test("numbers an ordered list and pads to the widest marker", () => {
    const items: ViewBlock[] = Array.from({ length: 10 }, (_, i) => ({
      kind: "text",
      text: `item ${i}`,
    }));
    const painted = paint({ kind: "list", items, ordered: true });
    expect(painted[0]).toBe("1.  item 0");
    expect(painted[9]).toBe("10. item 9");
  });

  test("nests a list inside a list", () => {
    expect(
      paint({
        kind: "list",
        items: [
          {
            kind: "list",
            items: [
              { kind: "text", text: "inner" },
              { kind: "list", items: [{ kind: "text", text: "deepest" }] },
            ],
          },
          { kind: "text", text: "outer" },
        ],
      })
    ).toEqual(["• • inner", "  • • deepest", "• outer"]);
  });
});

describe("MarkdownPainter kv, link and notice", () => {
  test("bolds keys", () => {
    expect(
      paint({
        kind: "kv",
        pairs: [
          ["exit", "1"],
          ["signal", "SIGTERM"],
        ],
      })
    ).toEqual(["<b>exit:</b> 1", "<b>signal:</b> SIGTERM"]);
  });

  test("anchors a link and falls back to the href as label", () => {
    expect(paint({ kind: "link", href: "https://x/?a=1", label: "X" })).toEqual(
      ['<a href="https://x/?a=1">X</a>']
    );
    expect(paint({ kind: "link", href: "https://x", label: "" })).toEqual([
      '<a href="https://x">https://x</a>',
    ]);
  });

  test("prefixes a notice by severity", () => {
    expect(paint({ kind: "notice", text: "fyi", severity: "info" })).toEqual([
      "fyi",
    ]);
    expect(paint({ kind: "notice", text: "hmm", severity: "warn" })).toEqual([
      "⚠️ hmm",
    ]);
    expect(paint({ kind: "notice", text: "no", severity: "error" })).toEqual([
      "❌ no",
    ]);
  });
});

describe("MarkdownPainter.paintBody", () => {
  test("groups runs by frame", () => {
    const groups = MarkdownPainter.paintBody([
      { kind: "text", text: "one" },
      { kind: "file", path: "a.ts" },
      { kind: "code", lang: "", text: "x" },
      { kind: "section", label: "Next", content: [] },
    ]);

    expect(groups.map((group) => group.frame)).toEqual([
      "flow",
      "embed",
      "heading",
    ]);
    expect(groups[0]?.lines).toEqual(["one", "<code>a.ts</code>"]);
  });
});

describe("MarkdownPainter.paintTool", () => {
  const view: ToolView = {
    label: "Edit",
    icon: "edit",
    title: [{ kind: "file", path: "src/a.ts" }],
    summary: [{ kind: "spans", spans: [{ text: "+2/-1" }] }],
    body: [
      { kind: "text", text: "a payload nobody can expand" },
      {
        kind: "section",
        label: "Delete",
        icon: "trash",
        content: [{ kind: "file", path: "src/b.ts" }],
      },
      { kind: "code", lang: "", text: "another payload" },
    ],
  };

  test("keeps title and summary on one line and outlines body sections", () => {
    expect(MarkdownPainter.paintTool(view)).toEqual({
      icon: "✏️",
      lines: ["<code>a.ts</code> +2/-1", "🗑️ <code>b.ts</code>"],
    });
  });

  test("falls back to a generic icon and drops an empty head", () => {
    expect(MarkdownPainter.paintTool({ title: [] })).toEqual({
      icon: "⚙️",
      lines: [],
    });
  });
});
