import { describe, expect, test } from "bun:test";

import { Markdown } from "./Markdown";

describe("Markdown.toHtml", () => {
  test("escapes html-special characters in plain text", () => {
    expect(Markdown.toHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });

  test("bold + italic + strike + inline code", () => {
    expect(Markdown.toHtml("**b** *i* ~~s~~ `c`")).toBe(
      "<b>b</b> <i>i</i> <s>s</s> <code>c</code>"
    );
  });

  test("headings collapse to <b>", () => {
    expect(Markdown.toHtml("# H1")).toBe("<b>H1</b>");
    expect(Markdown.toHtml("### H3")).toBe("<b>H3</b>");
  });

  test("fenced code block with language", () => {
    expect(Markdown.toHtml("```ts\nconst x = 1;\n```")).toBe(
      '<pre><code class="language-ts">const x = 1;</code></pre>'
    );
  });

  test("fenced code block without language", () => {
    expect(Markdown.toHtml("```\nplain\n```")).toBe("<pre>plain</pre>");
  });

  test("escapes html inside code block", () => {
    expect(Markdown.toHtml("```\na <b> & c\n```")).toBe(
      "<pre>a &lt;b&gt; &amp; c</pre>"
    );
  });

  test("safe links pass through, javascript: dropped", () => {
    expect(Markdown.toHtml("[ok](https://example.com)")).toBe(
      '<a href="https://example.com">ok</a>'
    );
    expect(Markdown.toHtml("[bad](javascript:alert(1))")).toBe("bad");
  });

  test("images render as link to src", () => {
    expect(Markdown.toHtml("![alt](https://e.com/a.png)")).toBe(
      '<a href="https://e.com/a.png">alt</a>'
    );
  });

  test("blockquote wraps multi-line content", () => {
    expect(Markdown.toHtml("> a\n> b")).toBe("<blockquote>a\nb</blockquote>");
  });

  test("unordered list bullets and nested ◦", () => {
    const out = Markdown.toHtml("- one\n- two\n  - nested\n  - also");
    expect(out).toBe("• one\n• two\n    ◦ nested\n    ◦ also");
  });

  test("ordered list renders 1. 2. markers", () => {
    expect(Markdown.toHtml("1. a\n2. b\n3. c")).toBe("1. a\n2. b\n3. c");
  });

  test("task list checkboxes", () => {
    const out = Markdown.toHtml("- [x] done\n- [ ] todo");
    expect(out).toBe("✅ done\n⬜ todo");
  });

  test("thematic break renders em-dashes", () => {
    expect(Markdown.toHtml("a\n\n---\n\nb")).toBe("a\n\n———\n\nb");
  });

  test("collapses 3+ newlines to two", () => {
    expect(Markdown.toHtml("a\n\n\n\nb")).toBe("a\n\nb");
  });

  test("trims leading and trailing whitespace", () => {
    expect(Markdown.toHtml("\n\nhello\n\n")).toBe("hello");
  });

  test("table renders as padded monospace <pre>", () => {
    const md = "| Name | Score |\n| ---- | ----- |\n| Aaron | 99 |\n| Bo | 7 |";
    expect(Markdown.toHtml(md)).toBe(
      "<pre>| Name  | Score |\n|-------|-------|\n| Aaron | 99    |\n| Bo    | 7     |</pre>"
    );
  });

  test("table escapes html inside cells", () => {
    const md = "| a | b |\n| - | - |\n| <x> | & |";
    expect(Markdown.toHtml(md)).toContain("&lt;x&gt;");
    expect(Markdown.toHtml(md)).toContain("&amp;");
  });

  test("table surrounded by prose is rendered with both segments", () => {
    const md = "Hello\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nDone.";
    const out = Markdown.toHtml(md);
    expect(out.startsWith("Hello")).toBe(true);
    expect(out).toContain("<pre>");
    expect(out.endsWith("Done.")).toBe(true);
  });

  test("link inside emphasis nests correctly", () => {
    expect(Markdown.toHtml("*[a](https://e.com)*")).toBe(
      '<i><a href="https://e.com">a</a></i>'
    );
  });

  test("paragraphs are separated by blank line", () => {
    expect(Markdown.toHtml("one\n\ntwo")).toBe("one\n\ntwo");
  });

  test("inline html in source is escaped, never passed through", () => {
    expect(Markdown.toHtml("hello <script>alert(1)</script>")).toContain(
      "&lt;script&gt;"
    );
  });

  test("empty input returns empty string", () => {
    expect(Markdown.toHtml("")).toBe("");
    expect(Markdown.toHtml("   \n\n  ")).toBe("");
  });

  test("escape covers all four Telegram-supported named entities", () => {
    expect(Markdown.escape('& < > "')).toBe("&amp; &lt; &gt; &quot;");
  });

  test('link href containing " is escaped to &quot;', () => {
    expect(Markdown.toHtml('[x](https://e.com/?q="a")')).toBe(
      '<a href="https://e.com/?q=&quot;a&quot;">x</a>'
    );
  });
});
