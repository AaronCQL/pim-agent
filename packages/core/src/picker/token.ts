/**
 * Which picker the caret is sitting in, if any.
 *
 * The two patterns are the ones the TUI pickers already use — `@` anywhere
 * after whitespace, `/` only at the start of a line — so the same draft
 * produces the same completions in a terminal and in a browser. Only the
 * cursor model differs: one caret offset into a whole textarea here, a
 * `(line, column)` pair there.
 */
export type PickerToken = {
  readonly kind: "file" | "command";
  readonly query: string;
  /** Offset of the sigil itself, so a completion replaces it too. */
  readonly start: number;
};

export const AT_PREFIX = /(?:^|\s)@(\S*)$/;
export const SLASH_PREFIX = /^\/(\S*)$/;

/**
 * `AT_PREFIX` swallows the whitespace before the sigil when there is one, so
 * the sigil itself sits one character further in than the match.
 */
export function sigilOffset(match: RegExpMatchArray): number {
  const matched = match[0] ?? "";
  return (match.index ?? 0) + (matched.startsWith("@") ? 0 : 1);
}

export function isDirectoryItem(item: { readonly label: string }): boolean {
  return item.label.endsWith("/");
}

export function activeToken(
  text: string,
  caret: number
): PickerToken | undefined {
  const lineStart = text.lastIndexOf("\n", Math.max(0, caret - 1)) + 1;
  const beforeCaret = text.slice(lineStart, caret);

  const slash = SLASH_PREFIX.exec(beforeCaret);
  if (slash) {
    return { kind: "command", query: slash[1] ?? "", start: lineStart };
  }

  const at = AT_PREFIX.exec(beforeCaret);
  if (!at) {
    return undefined;
  }
  return {
    kind: "file",
    query: at[1] ?? "",
    start: lineStart + sigilOffset(at),
  };
}

/** A stable identity for a token, so a memo only fires when the query moves. */
export function tokenKey(token: PickerToken | undefined): string {
  return token === undefined ? "" : `${token.kind}\u0000${token.query}`;
}

export type Completion = {
  readonly text: string;
  readonly caret: number;
  /**
   * A directory keeps the picker open so the next segment can be drilled into
   * — the browser equivalent of the TUI's re-entered Tab.
   */
  readonly keepOpen: boolean;
};

export function applyCompletion(
  text: string,
  caret: number,
  token: PickerToken,
  item: { readonly value: string; readonly label: string }
): Completion {
  const inserted = token.kind === "file" ? `@${item.value}` : `${item.value} `;
  const head = text.slice(0, token.start);
  const tail = text.slice(caret);
  return {
    text: `${head}${inserted}${tail}`,
    caret: head.length + inserted.length,
    keepOpen: token.kind === "file" && isDirectoryItem(item),
  };
}
