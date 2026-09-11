import { describe, expect, test } from "bun:test";
import {
  createMarkdownSnapshotScript,
  renderMarkdownSnapshotTree,
  type MarkdownSnapshotElementNode,
  type MarkdownSnapshotNode,
} from "./WebViewMarkdownSnapshot";

const text = (value: string): MarkdownSnapshotNode => ({
  type: "text",
  text: value,
});

const element = (
  tagName: string,
  children: readonly MarkdownSnapshotNode[] = [],
  options: Partial<MarkdownSnapshotElementNode> = {}
): MarkdownSnapshotElementNode => ({
  type: "element",
  tagName,
  children,
  ...options,
});

describe("createMarkdownSnapshotScript", () => {
  test("builds a parseable browser snapshot script from stringified functions", () => {
    const script = createMarkdownSnapshotScript();

    expect(script).toStartWith("(function captureMarkdownSnapshot");
    expect(script).toContain("function renderMarkdownSnapshotTree");
    expect(script).toContain("function serializeNode");
    expect(script).not.toContain("const renderMarkdownSnapshotTree =");
    expect(() => new Function(script)).not.toThrow();
  });
});

describe("renderMarkdownSnapshotTree", () => {
  test("renders headings, inline formatting, code, and absolute links", () => {
    const root = element("body", [
      element("h1", [text("Hello")]),
      element("p", [
        text("Read "),
        element("strong", [text("docs")]),
        text(" at "),
        element("a", [text("guide")], {
          attributes: [{ name: "href", value: "/guide" }],
        }),
        text(" with "),
        element("code", [text("x")], { textContent: "x" }),
      ]),
    ]);

    expect(renderMarkdownSnapshotTree(root, "https://example.test/base/")).toBe(
      [
        "# Hello",
        "",
        "Read **docs** at [guide](https://example.test/guide) with `x`",
      ].join("\n")
    );
  });

  test("renders lists, blockquotes, tables, and fenced code blocks", () => {
    const root = element("body", [
      element("ul", [
        element("li", [text("one")]),
        element("li", [text("two")]),
      ]),
      element("blockquote", [element("p", [text("quoted")])]),
      element("table", [
        element("tbody", [
          element("tr", [
            element("th", [text("Name")]),
            element("th", [text("Value")]),
          ]),
          element("tr", [
            element("td", [text("A|B")]),
            element("td", [text("2")]),
          ]),
        ]),
      ]),
      element("pre", [element("code", [text("const x = 1;")])], {
        textContent: "const x = 1;",
      }),
    ]);

    expect(renderMarkdownSnapshotTree(root, "https://example.test/")).toBe(
      [
        "- one",
        "- two",
        "",
        "> quoted",
        "",
        "| Name | Value |",
        "| --- | --- |",
        "| A\\|B | 2 |",
        "",
        "```",
        "const x = 1;",
        "```",
      ].join("\n")
    );
  });

  test("skips hidden content and unsafe links", () => {
    const root = element("body", [
      element("p", [
        text("shown"),
        element("span", [text("hidden")], { ariaHidden: "true" }),
        element("a", [text("unsafe")], {
          attributes: [{ name: "href", value: "javascript:alert(1)" }],
        }),
      ]),
    ]);

    expect(renderMarkdownSnapshotTree(root, "https://example.test/")).toBe(
      "shown unsafe"
    );
  });
});
