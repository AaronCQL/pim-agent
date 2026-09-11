const maxBytes = 32 * 1024;
const maxLineLength = 2000;

function truncateLine(line: string): string {
  if (line.length <= maxLineLength) {
    return line;
  }

  return `${line.slice(0, maxLineLength)}... (line truncated to ${maxLineLength} chars)`;
}

function truncateUtf8(
  content: string,
  limit: number = maxBytes
): {
  readonly body: string;
  readonly returnedBytes: number;
  readonly totalBytes: number;
  readonly truncated: boolean;
} {
  const totalBytes = Buffer.byteLength(content, "utf8");

  if (totalBytes <= limit) {
    return {
      body: content,
      returnedBytes: totalBytes,
      totalBytes,
      truncated: false,
    };
  }

  const encoded = new TextEncoder().encode(content);
  let cut = limit;
  while (cut > 0 && ((encoded[cut] ?? 0) & 0xc0) === 0x80) {
    cut -= 1;
  }

  const body = new TextDecoder("utf-8").decode(encoded.subarray(0, cut));

  return { body, returnedBytes: cut, totalBytes, truncated: true };
}

function applyByteCap(
  items: readonly string[],
  options: {
    readonly maxBytes?: number;
    readonly separator?: string;
  } = {}
): {
  readonly visible: readonly string[];
  readonly droppedItems: number;
} {
  const limit = options.maxBytes ?? maxBytes;
  const separator = options.separator ?? "\n";
  const separatorBytes = Buffer.byteLength(separator, "utf8");
  const visible: string[] = [];
  let bytes = 0;

  for (const item of items) {
    const itemBytes = Buffer.byteLength(item, "utf8");
    const cost = visible.length === 0 ? itemBytes : separatorBytes + itemBytes;

    if (visible.length > 0 && bytes + cost > limit) {
      break;
    }

    visible.push(item);
    bytes += cost;

    if (bytes >= limit) {
      break;
    }
  }

  return { visible, droppedItems: items.length - visible.length };
}

export const OutputBudget = {
  maxBytes,
  maxLineLength,
  truncateLine,
  truncateUtf8,
  applyByteCap,
};
