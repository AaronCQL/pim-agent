export class Lines {
  public static readonly utf8Bom = "\uFEFF";
  public static readonly utf8BomBytes = new Uint8Array([0xef, 0xbb, 0xbf]);

  public static normalize(content: string): string {
    return Lines.stripUtf8Bom(content)
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n");
  }

  public static split(content: string): readonly string[] {
    const normalized = Lines.normalize(content);

    if (normalized.length === 0) {
      return [];
    }

    const parts = normalized.split("\n");

    if (parts.at(-1) === "") {
      parts.pop();
    }

    return parts;
  }

  public static hasTrailingNewline(content: string): boolean {
    return Lines.normalize(content).endsWith("\n");
  }

  /**
   * Given a truncated head prefix of a larger file, the 1-based line to resume
   * reading at so the (possibly mid-line) cut point is re-read in full. Matches
   * how `read` numbers lines via `split`, so the hint lands on the right line.
   */
  public static continuationLine(head: string): number {
    const { lines, hasTrailingNewline } = Lines.splitWithTrailingNewline(head);
    return Math.max(1, lines.length + (hasTrailingNewline ? 1 : 0));
  }

  public static splitWithTrailingNewline(content: string): {
    readonly lines: readonly string[];
    readonly hasTrailingNewline: boolean;
  } {
    const normalized = Lines.normalize(content);

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

  public static stripUtf8Bom(content: string): string {
    return content.startsWith(Lines.utf8Bom) ? content.slice(1) : content;
  }

  public static hasUtf8Bom(bytes: Uint8Array): boolean {
    return (
      bytes[0] === Lines.utf8BomBytes[0] &&
      bytes[1] === Lines.utf8BomBytes[1] &&
      bytes[2] === Lines.utf8BomBytes[2]
    );
  }

  public static async isBinary(file: Bun.BunFile): Promise<boolean> {
    const bytes = new Uint8Array(await file.slice(0, 8192).arrayBuffer());
    return bytes.includes(0);
  }
}
