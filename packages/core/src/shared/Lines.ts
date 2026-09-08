const utf8Bom = "\uFEFF";
const utf8BomBytes = new Uint8Array([0xef, 0xbb, 0xbf]);

function normalize(content: string): string {
  return stripUtf8Bom(content).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function splitNormalized(normalized: string): readonly string[] {
  if (normalized.length === 0) {
    return [];
  }

  const parts = normalized.split("\n");

  if (parts.at(-1) === "") {
    parts.pop();
  }

  return parts;
}

function split(content: string): readonly string[] {
  return splitNormalized(normalize(content));
}

function continuationLine(head: string): number {
  const { lines, hasTrailingNewline } = splitWithTrailingNewline(head);
  return Math.max(1, lines.length + (hasTrailingNewline ? 1 : 0));
}

function splitWithTrailingNewline(content: string): {
  readonly lines: readonly string[];
  readonly hasTrailingNewline: boolean;
} {
  const normalized = normalize(content);
  return {
    lines: splitNormalized(normalized),
    hasTrailingNewline: normalized.endsWith("\n"),
  };
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

export const Lines = {
  utf8Bom,
  normalize,
  split,
  splitNormalized,
  continuationLine,
  splitWithTrailingNewline,
  stripUtf8Bom,
  hasUtf8Bom,
  isBinary,
};
