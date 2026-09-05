const utf8Bom = "\uFEFF";
const utf8BomBytes = new Uint8Array([0xef, 0xbb, 0xbf]);

function normalize(content: string): string {
  return stripUtf8Bom(content).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function split(content: string): readonly string[] {
  const normalized = normalize(content);

  if (normalized.length === 0) {
    return [];
  }

  const parts = normalized.split("\n");

  if (parts.at(-1) === "") {
    parts.pop();
  }

  return parts;
}

function hasTrailingNewline(content: string): boolean {
  return normalize(content).endsWith("\n");
}

/**
 * Given a truncated head prefix of a larger file, the 1-based line to resume
 * reading at so the (possibly mid-line) cut point is re-read in full. Matches
 * how `read` numbers lines via `split`, so the hint lands on the right line.
 */
function continuationLine(head: string): number {
  const { lines, hasTrailingNewline } = splitWithTrailingNewline(head);
  return Math.max(1, lines.length + (hasTrailingNewline ? 1 : 0));
}

function splitWithTrailingNewline(content: string): {
  readonly lines: readonly string[];
  readonly hasTrailingNewline: boolean;
} {
  const normalized = normalize(content);

  if (normalized.length === 0) {
    return { lines: [], hasTrailingNewline: false };
  }

  const parts = normalized.split("\n");
  const hasTrailingNewline = parts.at(-1) === "";

  if (hasTrailingNewline) {
    parts.pop();
  }

  return { lines: parts, hasTrailingNewline };
}

function stripUtf8Bom(content: string): string {
  return content.startsWith(utf8Bom) ? content.slice(1) : content;
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return (
    bytes[0] === utf8BomBytes[0] &&
    bytes[1] === utf8BomBytes[1] &&
    bytes[2] === utf8BomBytes[2]
  );
}

async function isBinary(file: Bun.BunFile): Promise<boolean> {
  const bytes = new Uint8Array(await file.slice(0, 8192).arrayBuffer());
  return bytes.includes(0);
}

/**
 * The head of a body plus how much was left off, which is how every collapsed
 * payload is drawn: `preview` renders, and a non-zero `overflow` becomes the
 * `… N more lines` row. Frontend-agnostic on purpose — the TUI and the web
 * both truncate to the same place, so the rule lives here rather than in a
 * renderer.
 */
function buildPreviewLines(
  body: string,
  maxLines: number
): { preview: string; overflow: number } {
  const lines = body.split("\n");
  if (lines.length <= maxLines) {
    return { preview: body, overflow: 0 };
  }
  return {
    preview: lines.slice(0, maxLines).join("\n"),
    overflow: lines.length - maxLines,
  };
}

export const Lines = {
  utf8Bom,
  utf8BomBytes,
  normalize,
  split,
  hasTrailingNewline,
  continuationLine,
  splitWithTrailingNewline,
  stripUtf8Bom,
  hasUtf8Bom,
  isBinary,
  buildPreviewLines,
};
