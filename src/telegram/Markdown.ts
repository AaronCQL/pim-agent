type Align = "left" | "center" | "right";

type TableRow = ReadonlyArray<string>;

type Segment =
  | { readonly kind: "md"; readonly text: string }
  | {
      readonly kind: "table";
      readonly rows: ReadonlyArray<TableRow>;
      readonly aligns: ReadonlyArray<Align | undefined>;
    };

const SAFE_LINK = /^(https?:|tg:|mailto:)/i;

export class Markdown {
  public static toHtml(md: string): string {
    const segments = Markdown.split(Markdown.normalizeTildes(md));
    let out = "";
    for (const seg of segments) {
      out +=
        seg.kind === "md"
          ? Markdown.renderMd(seg.text)
          : Markdown.renderTable(seg.rows, seg.aligns);
    }
    return out.trim();
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
    paragraph: (c: string): string => `<p>${c}</p>`,
    heading: (c: string, meta?: { level?: number }): string => {
      const level = Math.min(6, Math.max(1, meta?.level ?? 1));
      return `<h${level}>${c}</h${level}>`;
    },
    strong: (c: string): string => `<b>${c}</b>`,
    emphasis: (c: string): string => `<i>${c}</i>`,
    strikethrough: (c: string): string => `<s>${c}</s>`,
    codespan: (c: string): string => `<code>${c}</code>`,
    code: (c: string, meta?: { language?: string }): string => {
      const body = c.replace(/\n+$/, "");
      const lang = meta?.language;
      if (lang === "math") {
        return `<tg-math-block>${body}</tg-math-block>`;
      }
      const open = lang
        ? `<pre><code class="language-${Markdown.escape(lang)}">`
        : "<pre>";
      const close = lang ? "</code></pre>" : "</pre>";
      return `${open}${body}${close}`;
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
    blockquote: (c: string): string => `<blockquote>${c}</blockquote>`,
    list: (c: string, meta?: { ordered?: boolean; start?: number }): string => {
      if (meta?.ordered) {
        const start = meta.start ?? 1;
        const startAttr = start > 1 ? ` start="${start}"` : "";
        return `<ol${startAttr}>${c}</ol>`;
      }
      return `<ul>${c}</ul>`;
    },
    listItem: (c: string, meta?: { checked?: boolean }): string => {
      const body = c.replace(/\n+$/, "");
      const checked = meta?.checked;
      if (checked === true) {
        return `<li><input type="checkbox" checked> ${body}</li>`;
      }
      if (checked === false) {
        return `<li><input type="checkbox"> ${body}</li>`;
      }
      return `<li>${body}</li>`;
    },
    hr: (): string => "<hr/>",
    br: (): string => "<br>",
    table: (c: string): string => c,
  };

  // Bun's GFM strikethrough treats a lone `~` as a delimiter, but Telegram
  // (and CommonMark) only strike on `~~`. Escape every lone tilde in prose so
  // doubled runs keep striking, while fenced blocks and inline code — whose
  // tildes are literal content, not prose — are lifted out untouched.
  private static readonly LIFT_TAG = "\uE000";
  private static readonly LONE_TILDE = /(?<!~)~(?!~)/g;

  private static normalizeTildes(md: string): string {
    if (!md.includes("~")) {
      return md;
    }
    const stash: string[] = [];
    const hold = (raw: string): string =>
      `${Markdown.LIFT_TAG}${stash.push(raw) - 1}${Markdown.LIFT_TAG}`;

    // Fenced code blocks: stash verbatim so their tildes aren't escaped.
    let out = "";
    const lines = md.split("\n");
    for (let i = 0; i < lines.length; ) {
      const line = lines[i]!;
      const open = /^(\s*)(`{3,}|~{3,})/.exec(line);
      if (!open) {
        out += `${line}\n`;
        i++;
        continue;
      }
      const fence = open[2]!;
      const closer = new RegExp(`^\\s*${fence.charAt(0)}{${fence.length},}`);
      const block: string[] = [line];
      i++;
      while (i < lines.length && !closer.test(lines[i]!)) {
        block.push(lines[i]!);
        i++;
      }
      if (i < lines.length) {
        block.push(lines[i]!);
        i++;
      }
      out += `${hold(block.join("\n"))}\n`;
    }
    out = out.replace(/\n$/, "");

    // Inline code spans: stash verbatim (backslash escapes don't apply inside).
    out = out.replace(/(`+)([^`]+?)(\1)/g, (w) => hold(w));

    // Escape lone tildes; `~~` and `~~~` runs are left intact to strike or fence.
    out = out.replace(Markdown.LONE_TILDE, "\\~");

    return out.replace(/\uE000(\d+)\uE000/g, (_w, n) => stash[Number(n)]!);
  }

  private static renderMd(md: string): string {
    if (!md.trim()) {
      return "";
    }
    return Bun.markdown.render(md, Markdown.RENDERERS);
  }

  private static renderInline(md: string): string {
    return Markdown.renderMd(md)
      .replace(/^<p>/, "")
      .replace(/<\/p>$/, "")
      .trim();
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
        const aligns = Markdown.parseAligns(next);
        i += 1;
        while (i + 1 < lines.length && Markdown.isPipeLine(lines[i + 1]!)) {
          i += 1;
          rows.push(Markdown.parseRow(lines[i]!));
        }
        segments.push({ kind: "table", rows, aligns });
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

  private static parseAligns(sep: string): (Align | undefined)[] {
    return Markdown.parseRow(sep).map((cell) => {
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

  private static renderTable(
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
        .map(
          (_, c) =>
            `<${tag}${attr(c)}>${Markdown.renderInline(row[c] ?? "")}</${tag}>`
        )
        .join("");

    let out = "<table>";
    out += `<tr>${cells(header, "th")}</tr>`;
    for (const row of dataRows) {
      out += `<tr>${cells(row, "td")}</tr>`;
    }
    out += "</table>";
    return out;
  }
}
