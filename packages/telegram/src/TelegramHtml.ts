import { Markdown } from "./Markdown";

export const BR = "<br>";

const MESSAGE_LIMIT = 32000;
const BLOCK_TAGS = new Set([
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ol",
  "p",
  "pre",
  "table",
  "tg-math-block",
  "ul",
]);
const VOID_BLOCK_TAGS = new Set(["br", "hr"]);

type HtmlTag = {
  readonly start: number;
  readonly end: number;
  readonly name: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
};

function capStatus(text: string): string {
  if (text.length <= MESSAGE_LIMIT) {
    return text;
  }
  const blocks = splitStatusBlocks(text);
  let dropped = 0;
  while (blocks.length > 1) {
    blocks.shift();
    dropped += 1;
    const rest = trimLeadingBreaks(blocks.join("").trimStart());
    const candidate = `<p>… ${dropped} earlier entries</p>${rest}`;
    if (candidate.length <= MESSAGE_LIMIT) {
      return candidate;
    }
  }
  return capPlainStatus(blocks);
}

function splitStatusBlocks(html: string): string[] {
  const blocks: string[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    const tag = nextStatusBlockTag(html, cursor);
    if (!tag) {
      pushStatusBlock(blocks, html.slice(cursor));
      break;
    }
    if (VOID_BLOCK_TAGS.has(tag.name)) {
      pushStatusBlock(blocks, html.slice(cursor, tag.end));
      cursor = tag.end;
      continue;
    }
    pushStatusBlock(blocks, html.slice(cursor, tag.start));
    const end = statusBlockEnd(html, tag);
    pushStatusBlock(blocks, html.slice(tag.start, end));
    cursor = end;
  }
  return blocks;
}

function nextStatusBlockTag(html: string, start: number): HtmlTag | undefined {
  const tags = htmlTags(html, start);
  for (const tag of tags) {
    if (tag.closing) {
      continue;
    }
    if (BLOCK_TAGS.has(tag.name) || VOID_BLOCK_TAGS.has(tag.name)) {
      return tag;
    }
  }
  return undefined;
}

function statusBlockEnd(html: string, opener: HtmlTag): number {
  if (opener.selfClosing) {
    return opener.end;
  }
  const stack = [opener.name];
  const tags = htmlTags(html, opener.end);
  for (const tag of tags) {
    if (VOID_BLOCK_TAGS.has(tag.name)) {
      continue;
    }
    if (!BLOCK_TAGS.has(tag.name)) {
      continue;
    }
    if (tag.closing) {
      if (stack.at(-1) === tag.name) {
        stack.pop();
      }
    } else if (!tag.selfClosing) {
      stack.push(tag.name);
    }
    if (stack.length === 0) {
      return tag.end;
    }
  }
  return html.length;
}

function* htmlTags(html: string, start: number): Generator<HtmlTag> {
  const re = /<\s*(\/)?\s*([a-z][\w:-]*)(?:\s[^>]*)?\/?\s*>/gi;
  re.lastIndex = start;
  for (let match = re.exec(html); match; match = re.exec(html)) {
    const raw = match[0]!;
    yield {
      start: match.index,
      end: re.lastIndex,
      name: match[2]!.toLowerCase(),
      closing: match[1] !== undefined,
      selfClosing: /\/\s*>$/.test(raw),
    };
  }
}

function pushStatusBlock(blocks: string[], block: string): void {
  if (block) {
    blocks.push(block);
  }
}

function trimLeadingBreaks(text: string): string {
  return text.replace(/^(?:<br\s*\/?>)+/i, "").trimStart();
}

function capPlainStatus(blocks: readonly string[]): string {
  let head = "";
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const candidate = `${head}${block}`;
    if (candidate.length <= MESSAGE_LIMIT) {
      head = candidate;
      continue;
    }
    const remaining = MESSAGE_LIMIT - head.length;
    const truncated = truncateHtmlHead(block, remaining);
    if (truncated) {
      head = `${head}${truncated}`;
    }
    break;
  }
  return head.trimEnd();
}

function truncateHtmlHead(html: string, limit: number): string {
  if (html.length <= limit) {
    return html;
  }
  if (limit <= 0) {
    return "";
  }
  const wrapper = outerHtmlWrapper(html);
  if (wrapper) {
    const innerLimit = limit - wrapper.open.length - wrapper.close.length;
    if (innerLimit > 0) {
      const inner = truncateHtmlHead(wrapper.inner, innerLimit);
      if (inner) {
        return `${wrapper.open}${inner}${wrapper.close}`;
      }
    }
  }
  return escapePlainHead(stripHtml(html), limit);
}

function outerHtmlWrapper(html: string):
  | {
      readonly open: string;
      readonly inner: string;
      readonly close: string;
    }
  | undefined {
  const opener = /^<\s*([a-z][\w:-]*)(?:\s[^>]*)?\/?\s*>/i.exec(html);
  if (!opener) {
    return undefined;
  }
  const open = opener[0]!;
  if (/\/\s*>$/.test(open)) {
    return undefined;
  }
  const name = opener[1]!.toLowerCase();
  const close = matchingHtmlCloseTag(html, name, open.length);
  if (!close || close.end !== html.length) {
    return undefined;
  }
  return {
    open,
    inner: html.slice(open.length, close.start),
    close: html.slice(close.start, close.end),
  };
}

function matchingHtmlCloseTag(
  html: string,
  name: string,
  start: number
): HtmlTag | undefined {
  let depth = 1;
  const tags = htmlTags(html, start);
  for (const tag of tags) {
    if (tag.name !== name) {
      continue;
    }
    if (tag.closing) {
      depth -= 1;
      if (depth === 0) {
        return tag;
      }
    } else if (!tag.selfClosing && !VOID_BLOCK_TAGS.has(tag.name)) {
      depth += 1;
    }
  }
  return undefined;
}

function escapePlainHead(text: string, limit: number): string {
  const marker = "…";
  if (limit < marker.length) {
    return "";
  }
  const budget = limit - marker.length;
  const escaped: string[] = [];
  let length = 0;
  for (const char of text) {
    const next = char === "\n" ? BR : Markdown.escape(char);
    if (length + next.length > budget) {
      break;
    }
    escaped.push(next);
    length += next.length;
  }
  return `${escaped.join("").trimEnd()}${marker}`;
}

function chunk(html: string): readonly string[] {
  if (html.length <= MESSAGE_LIMIT) {
    return [html];
  }
  const chunks: string[] = [];
  let rest = html;
  while (rest.length > MESSAGE_LIMIT) {
    const idx = rest.lastIndexOf(BR, MESSAGE_LIMIT);
    if (idx > 0) {
      chunks.push(rest.slice(0, idx).trim());
      rest = rest.slice(idx + BR.length).trim();
    } else {
      chunks.push(rest.slice(0, MESSAGE_LIMIT).trim());
      rest = rest.slice(MESSAGE_LIMIT).trim();
    }
  }
  if (rest) {
    chunks.push(rest);
  }
  return chunks;
}

function sanitize(text: string): string {
  return text.replace(
    /\b(api[_-]?key|token|secret)\b\s*[:=]\s*\S+/gi,
    "$1=[redacted]"
  );
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

export const TelegramHtml = {
  cap: capStatus,
  chunk,
  sanitize,
  strip: stripHtml,
};
