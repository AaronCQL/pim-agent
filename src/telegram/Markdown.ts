type TableRow = ReadonlyArray<string>;

type Segment =
  | { readonly kind: "md"; readonly text: string }
  | { readonly kind: "table"; readonly rows: ReadonlyArray<TableRow> };

const SAFE_LINK = /^(https?:|tg:|mailto:)/i;

export class Markdown {
  public static toHtml(md: string): string {
    const segments = Markdown.split(md);
    let out = "";
    for (const seg of segments) {
      out +=
        seg.kind === "md"
          ? Markdown.renderMd(seg.text)
          : Markdown.renderTable(seg.rows);
    }
    return out.replace(/\n{3,}/g, "\n\n").trim();
  }

  public static escape(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  private static readonly RENDERERS = {
    text: (c: string): string => Markdown.escape(c),
    paragraph: (c: string): string => `${c}\n\n`,
    heading: (c: string, meta?: { level?: number }): string =>
      meta?.level === 1 ? `<u><b>${c}</b></u>\n\n` : `<b>${c}</b>\n\n`,
    strong: (c: string): string => `<b>${c}</b>`,
    emphasis: (c: string): string => `<i>${c}</i>`,
    strikethrough: (c: string): string => `<s>${c}</s>`,
    codespan: (c: string): string => `<code>${c}</code>`,
    code: (c: string, meta?: { language?: string }): string => {
      const body = c.replace(/\n+$/, "");
      const lang = meta?.language;
      const open = lang
        ? `<pre><code class="language-${Markdown.escape(lang)}">`
        : "<pre>";
      const close = lang ? "</code></pre>" : "</pre>";
      return `${open}${body}${close}\n\n`;
    },
    link: (c: string, meta?: { href?: string }): string => {
      const href = meta?.href ?? "";
      return SAFE_LINK.test(href)
        ? `<a href="${Markdown.escape(href)}">${c}</a>`
        : c;
    },
    image: (c: string, meta?: { src?: string }): string => {
      const src = meta?.src ?? "";
      const alt = c || src;
      return SAFE_LINK.test(src)
        ? `<a href="${Markdown.escape(src)}">${alt}</a>`
        : alt;
    },
    blockquote: (c: string): string =>
      `<blockquote>${c.replace(/\n+$/, "")}</blockquote>\n\n`,
    list: (c: string, meta?: { depth?: number }): string =>
      (meta?.depth ?? 0) > 0 ? `\n${c}` : `${c}\n`,
    listItem: (
      c: string,
      meta?: {
        depth?: number;
        ordered?: boolean;
        index?: number;
        checked?: boolean;
      }
    ): string => {
      const depth = meta?.depth ?? 0;
      const ordered = meta?.ordered ?? false;
      const index = meta?.index ?? 0;
      const checked = meta?.checked;
      const indent = "    ".repeat(depth);
      let marker: string;
      if (checked === true) {
        marker = "✅";
      } else if (checked === false) {
        marker = "⬜";
      } else if (ordered) {
        marker = `${index + 1}.`;
      } else {
        marker = depth === 0 ? "•" : "◦";
      }
      return `${indent}${marker} ${c.replace(/\n+$/, "")}\n`;
    },
    hr: (): string => "───\n\n",
    br: (): string => "\n",
    table: (c: string): string => c,
  };

  private static renderMd(md: string): string {
    if (!md.trim()) {
      return "";
    }
    return Bun.markdown.render(md, Markdown.RENDERERS);
  }

  private static split(md: string): ReadonlyArray<Segment> {
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
      if (
        Markdown.isPipeLine(line) &&
        next !== undefined &&
        Markdown.isTableSeparator(next)
      ) {
        flushMd();
        const rows: string[][] = [Markdown.parseRow(line)];
        i += 1;
        while (i + 1 < lines.length && Markdown.isPipeLine(lines[i + 1]!)) {
          i += 1;
          rows.push(Markdown.parseRow(lines[i]!));
        }
        segments.push({ kind: "table", rows });
        continue;
      }
      buf.push(line);
    }
    flushMd();
    return segments;
  }

  private static isPipeLine(line: string): boolean {
    return /^\s*\|.*\|\s*$/.test(line);
  }

  private static isTableSeparator(line: string): boolean {
    return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line);
  }

  private static parseRow(line: string): string[] {
    const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    return trimmed.split("|").map((cell) => cell.trim());
  }

  private static renderTable(rows: ReadonlyArray<TableRow>): string {
    if (rows.length < 2) {
      return "";
    }
    const header = rows[0]!;
    const dataRows = rows.slice(1);
    if (dataRows.length === 0) {
      return "";
    }
    const pieces: string[] = [];
    for (const row of dataRows) {
      pieces.push("───");
      for (let c = 0; c < header.length; c++) {
        const label = Markdown.renderMd(header[c] ?? "").trim();
        const value = Markdown.renderMd(row[c] ?? "").trim();
        if (label) {
          pieces.push(`<b>${label}</b>: ${value}`);
        } else if (value) {
          pieces.push(value);
        }
      }
    }
    pieces.push("───");
    return `${pieces.join("\n")}\n\n`;
  }
}
