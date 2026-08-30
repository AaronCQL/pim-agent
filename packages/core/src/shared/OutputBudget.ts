export class OutputBudget {
  public static readonly maxBytes = 32 * 1024;
  public static readonly maxLineLength = 2000;

  public static truncateLine(line: string): string {
    if (line.length <= OutputBudget.maxLineLength) {
      return line;
    }

    return `${line.slice(0, OutputBudget.maxLineLength)}... (line truncated to ${OutputBudget.maxLineLength} chars)`;
  }

  public static truncateUtf8(
    content: string,
    maxBytes: number = OutputBudget.maxBytes
  ): {
    readonly body: string;
    readonly returnedBytes: number;
    readonly totalBytes: number;
    readonly truncated: boolean;
  } {
    const totalBytes = Buffer.byteLength(content, "utf8");

    if (totalBytes <= maxBytes) {
      return {
        body: content,
        returnedBytes: totalBytes,
        totalBytes,
        truncated: false,
      };
    }

    const encoded = new TextEncoder().encode(content);
    let cut = maxBytes;
    while (cut > 0 && ((encoded[cut] ?? 0) & 0xc0) === 0x80) {
      cut -= 1;
    }

    const body = new TextDecoder("utf-8").decode(encoded.subarray(0, cut));

    return { body, returnedBytes: cut, totalBytes, truncated: true };
  }

  public static applyByteCap(
    items: readonly string[],
    options: {
      readonly maxBytes?: number;
      readonly separator?: string;
    } = {}
  ): {
    readonly visible: readonly string[];
    readonly droppedItems: number;
  } {
    const maxBytes = options.maxBytes ?? OutputBudget.maxBytes;
    const separator = options.separator ?? "\n";
    const separatorBytes = Buffer.byteLength(separator, "utf8");
    const visible: string[] = [];
    let bytes = 0;

    for (const item of items) {
      const itemBytes = Buffer.byteLength(item, "utf8");
      const cost =
        visible.length === 0 ? itemBytes : separatorBytes + itemBytes;

      if (visible.length > 0 && bytes + cost > maxBytes) {
        break;
      }

      visible.push(item);
      bytes += cost;

      if (bytes >= maxBytes) {
        break;
      }
    }

    return { visible, droppedItems: items.length - visible.length };
  }
}
