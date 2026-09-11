/** Which picker the caret is sitting in, if any. */
export type PickerToken = {
  readonly kind: "file" | "command";
  readonly query: string;
  /** Offset of the sigil itself, so a completion replaces it too. */
  readonly start: number;
};

export const AT_PREFIX = /(?:^|\s)@(\S*)$/;
export const SLASH_PREFIX = /(?:^|\s)\/(\S*)$/;

/** Offset of the sigil in a match that also swallows the whitespace before it. */
export function sigilOffset(match: RegExpMatchArray): number {
  const matched = match[0] ?? "";
  return (match.index ?? 0) + (/^\s/.test(matched) ? 1 : 0);
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
    return {
      kind: "command",
      query: slash[1] ?? "",
      start: lineStart + sigilOffset(slash),
    };
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

export function tokenKey(token: PickerToken | undefined): string {
  return token === undefined ? "" : `${token.kind}\u0000${token.query}`;
}

export type Completion = {
  readonly text: string;
  readonly caret: number;
  /** A directory keeps the picker open so the next segment can be drilled into. */
  readonly keepOpen: boolean;
};

export function applyCompletion(
  text: string,
  caret: number,
  token: PickerToken,
  item: { readonly value: string; readonly label: string }
): Completion {
  const head = text.slice(0, token.start);
  const tail = text.slice(caret);
  const inserted =
    token.kind === "file"
      ? `@${item.value}`
      : `${item.value}${/^\s/.test(tail) ? "" : " "}`;
  return {
    text: `${head}${inserted}${tail}`,
    caret: head.length + inserted.length,
    keepOpen: token.kind === "file" && isDirectoryItem(item),
  };
}
