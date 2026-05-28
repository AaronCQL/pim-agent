import { platform } from "node:os";
import type { WebFetchPage } from "./fetch";

export type WebViewLike = {
  readonly url: string;
  readonly title: string;
  navigate: (url: string) => Promise<void>;
  evaluate: <T = unknown>(script: string) => Promise<T>;
  close: () => void;
};

export type WebViewFactory = () => WebViewLike;

type WebViewFetchClientOptions = {
  readonly factory?: WebViewFactory;
  readonly timeoutMs?: number;
};

type WebViewFetchInput = {
  readonly url: string;
  readonly signal?: AbortSignal;
};

type WebViewSnapshot = {
  readonly title: string;
  readonly url: string;
  readonly content: string;
};

class WebViewFetchClientError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WebViewFetchClientError";
  }
}

export class WebViewFetchClient {
  private static readonly defaultTimeoutMs = 20_000;

  private readonly factory: WebViewFactory;
  private readonly timeoutMs: number;

  public constructor(options: WebViewFetchClientOptions = {}) {
    this.factory = options.factory ?? WebViewFetchClient.defaultFactory;
    this.timeoutMs = options.timeoutMs ?? WebViewFetchClient.defaultTimeoutMs;
  }

  private static defaultFactory(): WebViewLike {
    return new Bun.WebView(
      platform() === "darwin" ? undefined : { backend: "chrome" }
    );
  }

  public async fetchHtml(input: WebViewFetchInput): Promise<WebFetchPage> {
    return this.capturePage(input, WebViewFetchClient.htmlSnapshotScript());
  }

  public async fetchMarkdown(input: WebViewFetchInput): Promise<WebFetchPage> {
    return this.capturePage(input, WebViewFetchClient.markdownSnapshotScript());
  }

  private async capturePage(
    input: WebViewFetchInput,
    snapshotScript: string
  ): Promise<WebFetchPage> {
    const signal = input.signal;

    if (signal?.aborted) {
      throw new WebViewFetchClientError("Request aborted.");
    }

    let view: WebViewLike;

    try {
      view = this.factory();
    } catch (error) {
      throw new WebViewFetchClientError(
        `Request failed: ${describeError(error)}`
      );
    }

    let aborted = false;
    let timedOut = false;
    const onAbort = () => {
      aborted = true;
      WebViewFetchClient.safeClose(view);
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      WebViewFetchClient.safeClose(view);
    }, this.timeoutMs);

    const checkInterrupted = (): void => {
      if (timedOut) {
        throw new WebViewFetchClientError(
          `Request timed out after ${this.timeoutMs}ms.`
        );
      }
      if (aborted) {
        throw new WebViewFetchClientError("Request aborted.");
      }
    };

    try {
      await view.navigate(input.url);
      checkInterrupted();

      const snapshot = WebViewFetchClient.readSnapshot(
        await view.evaluate<unknown>(snapshotScript)
      );

      if (snapshot.content.trim().length === 0) {
        throw new WebViewFetchClientError("Response contained empty content.");
      }

      const finalUrl =
        snapshot.url.length > 0
          ? snapshot.url
          : view.url.length > 0
            ? view.url
            : input.url;

      return {
        title: snapshot.title,
        url: finalUrl,
        content: snapshot.content,
      };
    } catch (error) {
      checkInterrupted();

      if (error instanceof WebViewFetchClientError) {
        throw error;
      }

      throw new WebViewFetchClientError(
        `Request failed: ${describeError(error)}`
      );
    } finally {
      clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", onAbort);
      WebViewFetchClient.safeClose(view);
    }
  }

  private static htmlSnapshotScript(): string {
    return String.raw`(() => ({
      title: document.title,
      url: location.href,
      content: document.documentElement.outerHTML,
    }))()`;
  }

  private static markdownSnapshotScript(): string {
    return String.raw`(() => {
      function textFallback() {
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

      try {
        const sourceRoot = document.body;

        if (!(sourceRoot instanceof HTMLElement)) {
          return textFallback();
        }

        const root = sourceRoot.cloneNode(true);

        if (!(root instanceof HTMLElement)) {
          return textFallback();
        }

        for (const node of root.querySelectorAll("script,style,noscript,svg,canvas,template,iframe")) {
          node.remove();
        }

        const blockTags = new Set([
          "address", "article", "aside", "blockquote", "dd", "details", "dialog", "div",
          "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2",
          "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p",
          "pre", "section", "table", "ul"
        ]);

        function renderNode(node, depth) {
          if (node.nodeType === Node.TEXT_NODE) {
            return normalizeInline(node.textContent || "");
          }

          if (!(node instanceof HTMLElement)) {
            return "";
          }

          const tag = node.tagName.toLowerCase();

          if (node.hidden || node.getAttribute("aria-hidden") === "true") {
            return "";
          }

          switch (tag) {
            case "h1": return block("# " + renderInlineChildren(node));
            case "h2": return block("## " + renderInlineChildren(node));
            case "h3": return block("### " + renderInlineChildren(node));
            case "h4": return block("#### " + renderInlineChildren(node));
            case "h5": return block("##### " + renderInlineChildren(node));
            case "h6": return block("###### " + renderInlineChildren(node));
            case "p": return block(renderInlineChildren(node));
            case "br": return "\n";
            case "hr": return "\n---\n\n";
            case "strong":
            case "b": return wrapInline("**", renderInlineChildren(node));
            case "em":
            case "i": return wrapInline("*", renderInlineChildren(node));
            case "code": return renderCode(node);
            case "pre": return renderPre(node);
            case "a": return renderLink(node);
            case "img": return renderImage(node);
            case "ul": return renderList(node, false, depth);
            case "ol": return renderList(node, true, depth);
            case "blockquote": return renderBlockquote(node, depth);
            case "table": return renderTable(node);
            case "thead":
            case "tbody":
            case "tfoot":
            case "tr":
            case "th":
            case "td": return "";
            default: {
              const rendered = renderChildren(node, depth);
              return blockTags.has(tag) ? block(rendered) : rendered;
            }
          }
        }

        function renderChildren(node, depth) {
          return joinMarkdown(Array.from(node.childNodes).map((child) => renderNode(child, depth)));
        }

        function renderInlineChildren(node) {
          return normalizeInline(
            Array.from(node.childNodes).map((child) => renderInlineNode(child)).filter((part) => part.trim().length > 0).join(" ")
          );
        }

        function renderInlineNode(node) {
          if (node.nodeType === Node.TEXT_NODE) {
            return normalizeInline(node.textContent || "");
          }

          if (!(node instanceof HTMLElement)) {
            return "";
          }

          const tag = node.tagName.toLowerCase();

          if (node.hidden || node.getAttribute("aria-hidden") === "true") {
            return "";
          }

          switch (tag) {
            case "br": return "\n";
            case "strong":
            case "b": return wrapInline("**", renderInlineChildren(node));
            case "em":
            case "i": return wrapInline("*", renderInlineChildren(node));
            case "code": return renderCode(node);
            case "a": return renderLink(node);
            case "img": return renderImage(node);
            default: return renderInlineChildren(node);
          }
        }

        function renderList(list, ordered, depth) {
          const items = Array.from(list.children).filter((child) => child.tagName.toLowerCase() === "li");
          const indent = "  ".repeat(depth);
          const lines = [];

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

        function renderBlockquote(node, depth) {
          const rendered = renderChildren(node, depth).trim();

          if (rendered.length === 0) {
            return "";
          }

          return rendered.split("\n").map((line) => line.trim().length === 0 ? ">" : "> " + line).join("\n") + "\n\n";
        }

        function renderTable(table) {
          const rows = Array.from(table.querySelectorAll("tr"))
            .map((row) => Array.from(row.querySelectorAll("th,td")).map((cell) => renderInlineChildren(cell).replace(/\|/g, "\\|")))
            .filter((row) => row.length > 0);

          if (rows.length === 0) {
            return "";
          }

          const width = Math.max(...rows.map((row) => row.length));
          const normalizedRows = rows.map((row) => padRow(row, width));
          const header = normalizedRows[0];
          const body = normalizedRows.slice(1);
          const lines = [
            "| " + header.join(" | ") + " |",
            "| " + header.map(() => "---").join(" | ") + " |",
            ...body.map((row) => "| " + row.join(" | ") + " |"),
          ];

          return lines.join("\n") + "\n\n";
        }

        function padRow(row, width) {
          return Array.from({ length: width }, (_, index) => row[index] || "");
        }

        function renderPre(node) {
          const text = (node.textContent || "").replace(/^\n+|\n+$/g, "");

          if (text.length === 0) {
            return "";
          }

          const fence = String.fromCharCode(96).repeat(3);
          return fence + "\n" + text + "\n" + fence + "\n\n";
        }

        function renderCode(node) {
          if (node.parentElement?.tagName.toLowerCase() === "pre") {
            return node.textContent || "";
          }

          const backtick = String.fromCharCode(96);
          const text = normalizeInline(node.textContent || "").replace(new RegExp(backtick, "g"), "\\" + backtick);
          return text.length === 0 ? "" : backtick + text + backtick;
        }

        function renderLink(node) {
          const text = renderInlineChildren(node);
          const href = node.getAttribute("href");

          if (text.length === 0) {
            return "";
          }

          if (href === null || href.trim().length === 0 || href.trim().toLowerCase().startsWith("javascript:")) {
            return text;
          }

          try {
            return "[" + text.replace(/[\[\]]/g, "") + "](" + new URL(href, location.href).href + ")";
          } catch {
            return text;
          }
        }

        function renderImage(node) {
          const alt = normalizeInline(node.getAttribute("alt") || "");

          if (alt.length === 0) {
            return "";
          }

          return "![" + alt.replace(/[\[\]]/g, "") + "]";
        }

        function block(text) {
          const trimmed = text.trim();
          return trimmed.length === 0 ? "" : trimmed + "\n\n";
        }

        function wrapInline(marker, text) {
          return text.length === 0 ? "" : marker + text + marker;
        }

        function normalizeInline(text) {
          return text.replace(/\s+/g, " ");
        }

        function joinMarkdown(parts) {
          let output = "";

          for (const part of parts) {
            if (part.length === 0) {
              continue;
            }

            if (output.length > 0 && !output.endsWith("\n") && !part.startsWith("\n")) {
              output += " ";
            }

            output += part;
          }

          return output;
        }

        const content = renderNode(root, 0)
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();

        return {
          title: document.title,
          url: location.href,
          content,
        };
      } catch {
        return textFallback();
      }
    })()`;
  }

  private static readSnapshot(value: unknown): WebViewSnapshot {
    if (typeof value !== "object" || value === null) {
      throw new WebViewFetchClientError("Response contained invalid payload.");
    }

    const record = value as Record<string, unknown>;

    if (typeof record["content"] !== "string") {
      throw new WebViewFetchClientError("Response contained invalid payload.");
    }

    return {
      content: record["content"],
      title: typeof record["title"] === "string" ? record["title"] : "",
      url: typeof record["url"] === "string" ? record["url"] : "",
    };
  }

  private static safeClose(view: WebViewLike): void {
    try {
      view.close();
    } catch {
      // close() throws if already closed; treat as idempotent.
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
