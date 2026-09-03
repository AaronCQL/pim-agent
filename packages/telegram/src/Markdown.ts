import { MarkdownPainter } from "../../core/src/view/MarkdownPainter";

type Align = "left" | "center" | "right";

type TableRow = ReadonlyArray<string>;

type Segment =
  | { readonly kind: "md"; readonly text: string }
  | {
      readonly kind: "table";
      readonly rows: ReadonlyArray<TableRow>;
      readonly aligns: ReadonlyArray<Align | undefined>;
    };

type RenderOptions = {
  readonly italics?: boolean;
};

const SAFE_LINK = /^(https?:|tg:|mailto:)/i;

// Bun's GFM strikethrough strikes on a lone `~`, but Telegram (and CommonMark)
// only strike on `~~`. We disable the parser's strikethrough and re-apply
// double-tilde runs in the text callback, where code spans/blocks never reach.
const STRIKETHROUGH = /(?<!~)~~(?!~)((?:[^~]|~(?!~))+?)~~(?!~)/g;

function toHtml(md: string, options: RenderOptions = {}): string {
  const segments = split(md);
  let out = "";
  for (const seg of segments) {
    out +=
      seg.kind === "md"
        ? renderMd(seg.text, options)
        : renderTable(seg.rows, seg.aligns);
  }
  return out.trim();
}

// One escaper for the whole Telegram HTML dialect, painter included.
function escape(s: string): string {
  return MarkdownPainter.escape(s);
}

const RENDERERS = {
  text: (c: string): string => escape(c).replace(STRIKETHROUGH, "<s>$1</s>"),
  paragraph: (c: string): string => `<p>${c}</p>`,
  heading: (c: string, meta?: { level?: number }): string => {
    const level = Math.min(6, Math.max(1, meta?.level ?? 1));
    return `<h${level}>${c}</h${level}>`;
  },
  strong: (c: string): string => `<b>${c}</b>`,
  emphasis: (c: string): string => `<i>${c}</i>`,
  codespan: (c: string): string => `<code>${c}</code>`,
  code: (c: string, meta?: { language?: string }): string => {
    const body = c.replace(/\n+$/, "");
    const lang = meta?.language;
    if (lang === "math") {
      return `<tg-math-block>${body}</tg-math-block>`;
    }
    const open = lang
      ? `<pre><code class="language-${escape(lang)}">`
      : "<pre>";
    const close = lang ? "</code></pre>" : "</pre>";
    return `${open}${body}${close}`;
  },
  link: (c: string, meta?: { href?: string }): string => {
    const href = meta?.href ?? "";
    return SAFE_LINK.test(href) ? `<a href="${escape(href)}">${c}</a>` : c;
  },
  image: (c: string, meta?: { src?: string }): string => {
    const src = meta?.src ?? "";
    const alt = c || src;
    return SAFE_LINK.test(src) ? `<a href="${escape(src)}">${alt}</a>` : alt;
  },
  blockquote: (c: string): string => `<blockquote>${c}</blockquote>`,
  list: (c: string, meta?: { ordered?: boolean; start?: number }): string => {
    if (meta?.ordered) {
      const start = meta.start ?? 1;
      const startAttr = start > 1 ? ` start="${start}"` : "";
      return `<ol${startAttr}>${c}</ol>`;
    }
    return `<ul>${c}</ul>`;
  },
  listItem: (c: string, meta?: { checked?: boolean }): string =>
    listItemHtml(c.replace(/\n+$/, ""), meta?.checked),
  hr: (): string => "<hr/>",
  br: (): string => "<br>",
  table: (c: string): string => c,
};

const ITALIC_RENDERERS = {
  ...RENDERERS,
  paragraph: (c: string): string => `<p>${italic(c)}</p>`,
  heading: (c: string, meta?: { level?: number }): string => {
    const level = Math.min(6, Math.max(1, meta?.level ?? 1));
    return `<h${level}>${italic(c)}</h${level}>`;
  },
  listItem: (c: string, meta?: { checked?: boolean }): string =>
    listItemHtml(italicListItemBody(c.replace(/\n+$/, "")), meta?.checked),
};

function listItemHtml(body: string, checked?: boolean): string {
  if (checked === true) {
    return `<li><input type="checkbox" checked> ${body}</li>`;
  }
  if (checked === false) {
    return `<li><input type="checkbox"> ${body}</li>`;
  }
  return `<li>${body}</li>`;
}

function renderMd(md: string, options: RenderOptions = {}): string {
  if (!md.trim()) {
    return "";
  }
  return Bun.markdown.render(md, renderers(options), {
    strikethrough: false,
  });
}

function renderers(options: RenderOptions): typeof RENDERERS {
  return options.italics ? ITALIC_RENDERERS : RENDERERS;
}

function italic(text: string): string {
  return text ? `<i>${text}</i>` : "";
}

// A nested list is appended to its parent item's content, so italicize only
// the leading text; wrapping a child <ul>/<ol> in <i> would be invalid.
function italicListItemBody(body: string): string {
  const nestedListIndex = body.search(/<(?:ul|ol)\b/);
  if (nestedListIndex < 0) {
    return italic(body);
  }
  const before = body.slice(0, nestedListIndex);
  return `${italic(before)}${body.slice(nestedListIndex)}`;
}

function renderInline(md: string): string {
  return renderMd(md)
    .replace(/^<p>/, "")
    .replace(/<\/p>$/, "")
    .trim();
}

function split(md: string): ReadonlyArray<Segment> {
  const lines = md.split("\n");
  const segments: Segment[] = [];
  let buf: string[] = [];

  const flushMd = (): void => {
    if (buf.length > 0) {
      segments.push({ kind: "md", text: buf.join("\n") });
      buf = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1];
    if (isPipeLine(line) && next !== undefined && isTableSeparator(next)) {
      flushMd();
      const rows: string[][] = [parseRow(line)];
      const aligns = parseAligns(next);
      i += 1;
      while (i + 1 < lines.length && isPipeLine(lines[i + 1]!)) {
        i += 1;
        rows.push(parseRow(lines[i]!));
      }
      segments.push({ kind: "table", rows, aligns });
      continue;
    }
    buf.push(line);
  }
  flushMd();
  return segments;
}

function isPipeLine(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line);
}

function parseRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function parseAligns(sep: string): (Align | undefined)[] {
  return parseRow(sep).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) {
      return "center";
    }
    if (right) {
      return "right";
    }
    if (left) {
      return "left";
    }
    return undefined;
  });
}

function renderTable(
  rows: ReadonlyArray<TableRow>,
  aligns: ReadonlyArray<Align | undefined>
): string {
  if (rows.length < 2) {
    return "";
  }
  const header = rows[0]!;
  const dataRows = rows.slice(1);
  if (dataRows.length === 0) {
    return "";
  }
  const attr = (col: number): string => {
    const align = aligns[col];
    return align ? ` align="${align}"` : "";
  };
  const cells = (row: TableRow, tag: "th" | "td"): string =>
    header
      .map((_, c) => `<${tag}${attr(c)}>${renderInline(row[c] ?? "")}</${tag}>`)
      .join("");

  let out = "<table>";
  out += `<tr>${cells(header, "th")}</tr>`;
  for (const row of dataRows) {
    out += `<tr>${cells(row, "td")}</tr>`;
  }
  out += "</table>";
  return out;
}

export const Markdown = { toHtml, escape };
