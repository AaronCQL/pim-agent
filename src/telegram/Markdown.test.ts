import { describe, expect, test } from "bun:test";

import { Markdown } from "./Markdown";

describe("toHtml", () => {
  test("escapes html-special characters in plain text", () => {
    expect(Markdown.toHtml("a < b & c > d")).toBe(
      "<p>a &lt; b &amp; c &gt; d</p>"
    );
  });

  test("bold + italic + strike + inline code", () => {
    expect(Markdown.toHtml("**b** *i* ~~s~~ `c`")).toBe(
      "<p><b>b</b> <i>i</i> <s>s</s> <code>c</code></p>"
    );
  });

  test("headings become structural h-tags", () => {
    expect(Markdown.toHtml("# H1")).toBe("<h1>H1</h1>");
    expect(Markdown.toHtml("## H2")).toBe("<h2>H2</h2>");
    expect(Markdown.toHtml("### H3")).toBe("<h3>H3</h3>");
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

  test("math fence becomes a rich math block", () => {
    expect(Markdown.toHtml("```math\nE = mc^2\n```")).toBe(
      "<tg-math-block>E = mc^2</tg-math-block>"
    );
  });

  test("safe links pass through, javascript: dropped", () => {
    expect(Markdown.toHtml("[ok](https://example.com)")).toBe(
      '<p><a href="https://example.com">ok</a></p>'
    );
    expect(Markdown.toHtml("[bad](javascript:alert(1))")).toBe("<p>bad</p>");
  });

  test("images render as link to src", () => {
    expect(Markdown.toHtml("![alt](https://e.com/a.png)")).toBe(
      '<p><a href="https://e.com/a.png">alt</a></p>'
    );
  });

  test("blockquote wraps content", () => {
    expect(Markdown.toHtml("> a\n> b")).toBe(
      "<blockquote><p>a\nb</p></blockquote>"
    );
  });

  test("unordered list nests as real ul/li", () => {
    expect(Markdown.toHtml("- one\n- two\n  - nested\n  - also")).toBe(
      "<ul><li>one</li><li>two<ul><li>nested</li><li>also</li></ul></li></ul>"
    );
  });

  test("ordered list renders ol/li", () => {
    expect(Markdown.toHtml("1. a\n2. b\n3. c")).toBe(
      "<ol><li>a</li><li>b</li><li>c</li></ol>"
    );
  });

  test("ordered list preserves a non-one start", () => {
    expect(Markdown.toHtml("3. three\n4. four")).toBe(
      '<ol start="3"><li>three</li><li>four</li></ol>'
    );
  });

  test("task list renders checkbox inputs", () => {
    expect(Markdown.toHtml("- [x] done\n- [ ] todo")).toBe(
      '<ul><li><input type="checkbox" checked> done</li>' +
        '<li><input type="checkbox"> todo</li></ul>'
    );
  });

  test("thematic break becomes a horizontal rule", () => {
    expect(Markdown.toHtml("a\n\n---\n\nb")).toBe("<p>a</p><hr/><p>b</p>");
  });

  test("does not insert separators between adjacent paragraphs", () => {
    expect(Markdown.toHtml("a\n\n\n\nb")).toBe("<p>a</p><p>b</p>");
  });

  test("trims leading and trailing whitespace", () => {
    expect(Markdown.toHtml("\n\nhello\n\n")).toBe("<p>hello</p>");
  });

  test("table renders as a real html table", () => {
    const md = "| Name | Score |\n| ---- | ----- |\n| Aaron | 99 |\n| Bo | 7 |";
    expect(Markdown.toHtml(md)).toBe(
      "<table><tr><th>Name</th><th>Score</th></tr>" +
        "<tr><td>Aaron</td><td>99</td></tr>" +
        "<tr><td>Bo</td><td>7</td></tr></table>"
    );
  });

  test("table carries column alignment", () => {
    const md = "| L | C | R |\n|:--|:-:|--:|\n| a | b | c |";
    expect(Markdown.toHtml(md)).toBe(
      '<table><tr><th align="left">L</th><th align="center">C</th>' +
        '<th align="right">R</th></tr>' +
        '<tr><td align="left">a</td><td align="center">b</td>' +
        '<td align="right">c</td></tr></table>'
    );
  });

  test("table renders markdown formatting in cells", () => {
    const md = "| a | b |\n| - | - |\n| **x** | `y` |";
    const out = Markdown.toHtml(md);
    expect(out).toContain("<td><b>x</b></td>");
    expect(out).toContain("<td><code>y</code></td>");
  });

  test("table escapes html inside cells", () => {
    const md = "| a | b |\n| - | - |\n| <x> | & |";
    const out = Markdown.toHtml(md);
    expect(out).toContain("&lt;x&gt;");
    expect(out).toContain("&amp;");
    expect(out).not.toContain("<pre>");
  });

  test("table surrounded by prose keeps both segments", () => {
    const md = "Hello\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nDone.";
    expect(Markdown.toHtml(md)).toBe(
      "<p>Hello</p><table><tr><th>a</th><th>b</th></tr>" +
        "<tr><td>1</td><td>2</td></tr></table><p>Done.</p>"
    );
  });

  test("link inside emphasis nests correctly", () => {
    expect(Markdown.toHtml("*[a](https://e.com)*")).toBe(
      '<p><i><a href="https://e.com">a</a></i></p>'
    );
  });

  test("paragraphs render as separate p blocks", () => {
    expect(Markdown.toHtml("one\n\ntwo")).toBe("<p>one</p><p>two</p>");
  });

  test("dollar amounts stay literal text", () => {
    expect(Markdown.toHtml("$15K/mth cash + ~$1.2M vest")).toBe(
      "<p>$15K/mth cash + ~$1.2M vest</p>"
    );
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
      '<p><a href="https://e.com/?q=&quot;a&quot;">x</a></p>'
    );
  });
});
