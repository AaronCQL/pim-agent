export type MarkdownSnapshotTextNode = {
  readonly type: "text";
  readonly text: string;
};

export type MarkdownSnapshotElementNode = {
  readonly type: "element";
  readonly tagName: string;
  readonly hidden?: boolean;
  readonly ariaHidden?: string | null;
  readonly attributes?: readonly {
    readonly name: string;
    readonly value: string;
  }[];
  readonly children?: readonly MarkdownSnapshotNode[];
  readonly textContent?: string;
};

export type MarkdownSnapshotNode =
  | MarkdownSnapshotTextNode
  | MarkdownSnapshotElementNode;

type BrowserMarkdownSnapshotRenderer = (
  root: MarkdownSnapshotNode,
  baseUrl: string
) => string;

type BrowserMarkdownSnapshot = {
  readonly title: string;
  readonly url: string;
  readonly content: string;
};

export function createMarkdownSnapshotScript(): string {
  return `(${captureMarkdownSnapshot.toString()})(${renderMarkdownSnapshotTree.toString()})`;
}

function captureMarkdownSnapshot(
  renderMarkdownSnapshotTree: BrowserMarkdownSnapshotRenderer
): BrowserMarkdownSnapshot {
  function textFallback(): BrowserMarkdownSnapshot {
    const content = (document.body?.innerText || "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return {
      title: document.title,
      url: location.href,
      content,
    };
  }

  function serializeNode(node: Node): MarkdownSnapshotNode | undefined {
    if (node.nodeType === Node.TEXT_NODE) {
      return { type: "text", text: node.textContent || "" };
    }

    if (!(node instanceof HTMLElement)) {
      return undefined;
    }

    const tagName = node.tagName.toLowerCase();

    if (
      [
        "script",
        "style",
        "noscript",
        "svg",
        "canvas",
        "template",
        "iframe",
      ].includes(tagName)
    ) {
      return undefined;
    }

    return {
      type: "element",
      tagName,
      hidden: Boolean(node.hidden) || node.hasAttribute("hidden"),
      ariaHidden: node.getAttribute("aria-hidden"),
      attributes: ["href", "alt"]
        .map((name) => ({ name, value: node.getAttribute(name) }))
        .filter(
          (
            attribute
          ): attribute is { readonly name: string; readonly value: string } =>
            attribute.value !== null
        ),
      children: Array.from(node.childNodes)
        .map(serializeNode)
        .filter((child): child is MarkdownSnapshotNode => child !== undefined),
      textContent: node.textContent || "",
    };
  }

  try {
    const sourceRoot = document.body;

    if (!(sourceRoot instanceof HTMLElement)) {
      return textFallback();
    }

    const root = serializeNode(sourceRoot);

    if (root === undefined) {
      return textFallback();
    }

    return {
      title: document.title,
      url: location.href,
      content: renderMarkdownSnapshotTree(root, location.href),
    };
  } catch {
    return textFallback();
  }
}

export function renderMarkdownSnapshotTree(
  root: MarkdownSnapshotNode,
  baseUrl: string
): string {
  const blockTags = new Set([
    "address",
    "article",
    "aside",
    "blockquote",
    "dd",
    "details",
    "dialog",
    "div",
    "dl",
    "dt",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "li",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "ul",
  ]);

  function renderNode(node: MarkdownSnapshotNode, depth: number): string {
    if (node.type === "text") {
      return normalizeInline(node.text || "");
    }

    if (node.type !== "element") {
      return "";
    }

    const tag = String(node.tagName || "").toLowerCase();

    if (node.hidden === true || node.ariaHidden === "true") {
      return "";
    }

    switch (tag) {
      case "h1":
        return block("# " + renderInlineChildren(node));
      case "h2":
        return block("## " + renderInlineChildren(node));
      case "h3":
        return block("### " + renderInlineChildren(node));
      case "h4":
        return block("#### " + renderInlineChildren(node));
      case "h5":
        return block("##### " + renderInlineChildren(node));
      case "h6":
        return block("###### " + renderInlineChildren(node));
      case "p":
        return block(renderInlineChildren(node));
      case "br":
        return "\n";
      case "hr":
        return "\n---\n\n";
      case "strong":
      case "b":
        return wrapInline("**", renderInlineChildren(node));
      case "em":
      case "i":
        return wrapInline("*", renderInlineChildren(node));
      case "code":
        return renderCode(node);
      case "pre":
        return renderPre(node);
      case "a":
        return renderLink(node);
      case "img":
        return renderImage(node);
      case "ul":
        return renderList(node, false, depth);
      case "ol":
        return renderList(node, true, depth);
      case "blockquote":
        return renderBlockquote(node, depth);
      case "table":
        return renderTable(node);
      case "thead":
      case "tbody":
      case "tfoot":
      case "tr":
      case "th":
      case "td":
        return "";
      default: {
        const rendered = renderChildren(node, depth);
        return blockTags.has(tag) ? block(rendered) : rendered;
      }
    }
  }

  function renderChildren(
    node: MarkdownSnapshotElementNode,
    depth: number
  ): string {
    return joinMarkdown(
      getChildren(node).map((child) => renderNode(child, depth))
    );
  }

  function renderInlineChildren(node: MarkdownSnapshotElementNode): string {
    return normalizeInline(
      getChildren(node)
        .map((child) => renderInlineNode(child))
        .filter((part) => part.trim().length > 0)
        .join(" ")
    );
  }

  function renderInlineNode(node: MarkdownSnapshotNode): string {
    if (node.type === "text") {
      return normalizeInline(node.text || "");
    }

    if (node.type !== "element") {
      return "";
    }

    const tag = String(node.tagName || "").toLowerCase();

    if (node.hidden === true || node.ariaHidden === "true") {
      return "";
    }

    switch (tag) {
      case "br":
        return "\n";
      case "strong":
      case "b":
        return wrapInline("**", renderInlineChildren(node));
      case "em":
      case "i":
        return wrapInline("*", renderInlineChildren(node));
      case "code":
        return renderCode(node);
      case "a":
        return renderLink(node);
      case "img":
        return renderImage(node);
      default:
        return renderInlineChildren(node);
    }
  }

  function renderList(
    list: MarkdownSnapshotElementNode,
    ordered: boolean,
    depth: number
  ): string {
    const items = getChildren(list).filter(
      (child): child is MarkdownSnapshotElementNode =>
        child.type === "element" && child.tagName.toLowerCase() === "li"
    );
    const indent = "  ".repeat(depth);
    const lines: string[] = [];

    items.forEach((item, index) => {
      const marker = ordered ? String(index + 1) + ". " : "- ";
      const body = renderChildren(item, depth + 1).trim();

      if (body.length === 0) {
        return;
      }

      const bodyLines = body.split("\n");
      lines.push(indent + marker + bodyLines[0]);

      for (const line of bodyLines.slice(1)) {
        lines.push(line.trim().length === 0 ? "" : indent + "  " + line);
      }
    });

    return lines.length === 0 ? "" : "\n" + lines.join("\n") + "\n\n";
  }

  function renderBlockquote(
    node: MarkdownSnapshotElementNode,
    depth: number
  ): string {
    const rendered = renderChildren(node, depth).trim();

    if (rendered.length === 0) {
      return "";
    }

    return (
      rendered
        .split("\n")
        .map((line) => (line.trim().length === 0 ? ">" : "> " + line))
        .join("\n") + "\n\n"
    );
  }

  function renderTable(table: MarkdownSnapshotElementNode): string {
    const rows = descendants(table, ["tr"])
      .map((row) =>
        descendants(row, ["th", "td"]).map((cell) =>
          renderInlineChildren(cell).replace(/\|/g, "\\|")
        )
      )
      .filter((row) => row.length > 0);

    if (rows.length === 0) {
      return "";
    }

    const width = Math.max(...rows.map((row) => row.length));
    const normalizedRows = rows.map((row) => padRow(row, width));
    const header = normalizedRows[0] ?? [];
    const body = normalizedRows.slice(1);
    const lines = [
      "| " + header.join(" | ") + " |",
      "| " + header.map(() => "---").join(" | ") + " |",
      ...body.map((row) => "| " + row.join(" | ") + " |"),
    ];

    return lines.join("\n") + "\n\n";
  }

  function padRow(row: readonly string[], width: number): string[] {
    return Array.from({ length: width }, (_, index) => row[index] || "");
  }

  function renderPre(node: MarkdownSnapshotElementNode): string {
    const text = (node.textContent || "").replace(/^\n+|\n+$/g, "");

    if (text.length === 0) {
      return "";
    }

    const fence = String.fromCharCode(96).repeat(3);
    return fence + "\n" + text + "\n" + fence + "\n\n";
  }

  function renderCode(node: MarkdownSnapshotElementNode): string {
    const backtick = String.fromCharCode(96);
    const text = normalizeInline(node.textContent || textContent(node)).replace(
      new RegExp(backtick, "g"),
      "\\" + backtick
    );
    return text.length === 0 ? "" : backtick + text + backtick;
  }

  function renderLink(node: MarkdownSnapshotElementNode): string {
    const text = renderInlineChildren(node);
    const href = getAttribute(node, "href");

    if (text.length === 0) {
      return "";
    }

    if (
      href === undefined ||
      href.trim().length === 0 ||
      href.trim().toLowerCase().startsWith("javascript:")
    ) {
      return text;
    }

    try {
      return (
        "[" +
        text.replace(/[[\]]/g, "") +
        "](" +
        new URL(href, baseUrl).href +
        ")"
      );
    } catch {
      return text;
    }
  }

  function renderImage(node: MarkdownSnapshotElementNode): string {
    const alt = normalizeInline(getAttribute(node, "alt") || "");

    if (alt.length === 0) {
      return "";
    }

    return "![" + alt.replace(/[[\]]/g, "") + "]";
  }

  function block(text: string): string {
    const trimmed = text.trim();
    return trimmed.length === 0 ? "" : trimmed + "\n\n";
  }

  function wrapInline(marker: string, text: string): string {
    return text.length === 0 ? "" : marker + text + marker;
  }

  function normalizeInline(text: string): string {
    return String(text).replace(/\s+/g, " ");
  }

  function joinMarkdown(parts: readonly string[]): string {
    let output = "";

    for (const part of parts) {
      if (part.length === 0) {
        continue;
      }

      if (
        output.length > 0 &&
        !output.endsWith("\n") &&
        !part.startsWith("\n")
      ) {
        output += " ";
      }

      output += part;
    }

    return output;
  }

  function getChildren(
    node: MarkdownSnapshotElementNode
  ): readonly MarkdownSnapshotNode[] {
    return Array.isArray(node.children) ? node.children : [];
  }

  function getAttribute(
    node: MarkdownSnapshotElementNode,
    name: string
  ): string | undefined {
    const attributes = Array.isArray(node.attributes) ? node.attributes : [];
    const attribute = attributes.find((item) => item.name === name);
    return typeof attribute?.value === "string" ? attribute.value : undefined;
  }

  function textContent(node: MarkdownSnapshotNode): string {
    if (node.type === "text") {
      return node.text || "";
    }

    return getChildren(node)
      .map((child) => textContent(child))
      .join("");
  }

  function descendants(
    node: MarkdownSnapshotElementNode,
    tags: readonly string[]
  ): MarkdownSnapshotElementNode[] {
    const matches: MarkdownSnapshotElementNode[] = [];
    const tagSet = new Set(tags);

    function visit(current: MarkdownSnapshotElementNode): void {
      for (const child of getChildren(current)) {
        if (child.type !== "element") {
          continue;
        }

        if (tagSet.has(String(child.tagName || "").toLowerCase())) {
          matches.push(child);
        }

        visit(child);
      }
    }

    visit(node);
    return matches;
  }

  return renderNode(root, 0)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
