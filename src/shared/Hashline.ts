export type Anchor = {
  readonly line: number;
  readonly hash: string;
  readonly textHint?: string;
};

export type HashMismatch = {
  readonly line: number;
  readonly expected: string;
  readonly actual: string;
};

export type RebasedAnchor = {
  readonly line: number;
  readonly warning: string;
};

const omittedBigrams = new Set([
  "bq",
  "gk",
  "gq",
  "jv",
  "jz",
  "kq",
  "kz",
  "lq",
  "nq",
  "qf",
  "qg",
  "qj",
  "qk",
  "qv",
  "qz",
  "rj",
  "tq",
  "wq",
  "wz",
  "xg",
  "xj",
  "xk",
  "xq",
  "xv",
  "xw",
  "yq",
  "zj",
  "zq",
  "zv",
]);

const buildHashlineBigrams = (): readonly string[] => {
  const bigrams: string[] = [];
  const letters = "abcdefghijklmnopqrstuvwxyz";

  for (const first of letters) {
    for (const second of letters) {
      const bigram = `${first}${second}`;

      if (!omittedBigrams.has(bigram)) {
        bigrams.push(bigram);
      }
    }
  }

  return bigrams;
};

export class HashlineMismatchError extends Error {
  public constructor(
    public readonly mismatches: readonly HashMismatch[],
    public readonly fileLines: readonly string[]
  ) {
    super(HashlineMismatchError.formatMessage(mismatches, fileLines));
    this.name = "HashlineMismatchError";
  }

  private static formatMessage(
    mismatches: readonly HashMismatch[],
    fileLines: readonly string[]
  ): string {
    const noun = mismatches.length === 1 ? "anchor" : "anchors";
    const lines = [
      `[E_HASH_MISMATCH] ${mismatches.length} stale ${noun}. Retry with the *-marked LINE+ID|content lines below; keep both endpoints for range replaces.`,
      "",
    ];
    const mismatchLines = new Set(mismatches.map((mismatch) => mismatch.line));
    let previous = 0;

    for (const lineNumber of HashlineMismatchError.displayLines(
      mismatches,
      fileLines
    )) {
      if (previous !== 0 && lineNumber > previous + 1) {
        lines.push("...");
      }

      previous = lineNumber;
      const marker = mismatchLines.has(lineNumber) ? "*" : " ";
      lines.push(
        `${marker}${Hashline.formatLine(lineNumber, fileLines[lineNumber - 1] ?? "")}`
      );
    }

    return lines.join("\n");
  }

  private static displayLines(
    mismatches: readonly HashMismatch[],
    fileLines: readonly string[]
  ): readonly number[] {
    const display = new Set<number>();

    for (const mismatch of mismatches) {
      const start = Math.max(1, mismatch.line - 2);
      const end = Math.min(fileLines.length, mismatch.line + 2);

      for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
        display.add(lineNumber);
      }
    }

    return [...display].sort((left, right) => left - right);
  }
}

export class Hashline {
  public static readonly alphabet = buildHashlineBigrams();

  private static readonly hashAlphabetPattern = /^[a-z]{2}$/u;
  private static readonly anchorPattern =
    /^\s*[>+\-*]*\s*(\d+)\s*([a-z]{2})(?:\|(.*))?\s*$/u;
  private static readonly significantPattern = /[\p{L}\p{N}]/u;
  private static readonly structuralPattern = /^[\s{}]*$/u;
  private static readonly fuzzyReplacementPattern = /[‘’‚‛“”„‟‐-―−   -   　]/gu;

  public static computeLineHash(lineIndex: number, line: string): string {
    const normalized = line.replaceAll("\r", "").trimEnd();

    if (Hashline.structuralPattern.test(normalized)) {
      return Hashline.ordinalSuffix(lineIndex);
    }

    const seed = Hashline.significantPattern.test(normalized) ? 0 : lineIndex;
    return Hashline.alphabet[
      Bun.hash.xxHash32(normalized, seed) % Hashline.alphabet.length
    ] as string;
  }

  public static formatLine(lineIndex: number, line: string): string {
    return `${lineIndex}${Hashline.computeLineHash(lineIndex, line)}|${line}`;
  }

  public static render(
    content: string,
    options: { readonly startLine?: number } = {}
  ): string {
    const lines = Hashline.splitLines(content);

    if (lines.length === 0) {
      return "";
    }

    const startLine = options.startLine ?? 1;

    return lines
      .map((line, index) => Hashline.formatLine(startLine + index, line))
      .join("\n");
  }

  public static normalize(content: string): string {
    return content
      .replace(/^﻿/u, "")
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n");
  }

  public static splitLines(content: string): readonly string[] {
    const normalized = Hashline.normalize(content);

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
    return Hashline.normalize(content).endsWith("\n");
  }

  public static async isBinary(file: Bun.BunFile): Promise<boolean> {
    const bytes = new Uint8Array(await file.slice(0, 8192).arrayBuffer());
    return bytes.includes(0);
  }

  public static parseAnchor(ref: string): Anchor {
    const match = ref.match(Hashline.anchorPattern);

    if (match === null) {
      throw new Error(`[E_BAD_REF] ${Hashline.diagnoseAnchor(ref)}`);
    }

    const line = Number.parseInt(match[1] ?? "", 10);

    if (line < 1) {
      throw new Error(
        `[E_BAD_REF] Line number must be >= 1, got ${line} in "${ref}".`
      );
    }

    return {
      line,
      hash: match[2] ?? "",
      ...(match[3] === undefined ? {} : { textHint: match[3] }),
    };
  }

  public static verifyAnchor(
    fileLines: readonly string[],
    anchor: Anchor
  ):
    | { readonly ok: true; readonly line: string }
    | {
        readonly ok: false;
        readonly reason: string;
        readonly actual?: string;
      } {
    const line = fileLines[anchor.line - 1];

    if (line === undefined) {
      return {
        ok: false,
        reason: `Line ${anchor.line} does not exist (file has ${fileLines.length} lines).`,
      };
    }

    const actual = Hashline.computeLineHash(anchor.line, line);

    if (actual === anchor.hash) {
      return { ok: true, line };
    }

    return {
      ok: false,
      reason: `Line ${anchor.line} hash mismatch: expected ${anchor.hash}, got ${actual}.`,
      actual,
    };
  }

  public static tryRebaseAnchor(
    anchor: Anchor,
    fileLines: readonly string[],
    window = 5
  ): RebasedAnchor | undefined {
    const start = Math.max(1, anchor.line - window);
    const end = Math.min(fileLines.length, anchor.line + window);
    const matches: number[] = [];

    for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
      if (
        Hashline.computeLineHash(
          lineNumber,
          fileLines[lineNumber - 1] ?? ""
        ) === anchor.hash
      ) {
        matches.push(lineNumber);
      }
    }

    if (matches.length !== 1) {
      return undefined;
    }

    const line = matches[0] as number;
    const content = fileLines[line - 1] ?? "";

    if (
      anchor.textHint !== undefined &&
      !Hashline.isFuzzyEquivalent(anchor.textHint, content)
    ) {
      return undefined;
    }

    const original = `${anchor.line}${anchor.hash}`;
    const rebased = `${line}${anchor.hash}`;
    const warning =
      anchor.textHint === undefined
        ? `Auto-rebased anchor ${original} -> ${rebased} within ±${window} lines by hash only. Re-read if this target was not intended.`
        : `Auto-rebased anchor ${original} -> ${rebased} within ±${window} lines.`;

    return { line, warning };
  }

  public static isFuzzyEquivalent(expected: string, actual: string): boolean {
    return (
      Hashline.normalizeFuzzy(expected) === Hashline.normalizeFuzzy(actual)
    );
  }

  public static normalizeFuzzy(text: string): string {
    return text.trimEnd().replace(Hashline.fuzzyReplacementPattern, (value) => {
      if ("‘’‚‛".includes(value)) {
        return "'";
      }

      if ("“”„‟".includes(value)) {
        return '"';
      }

      if (/[‐-―−]/u.test(value)) {
        return "-";
      }

      return " ";
    });
  }

  private static ordinalSuffix(lineIndex: number): string {
    const mod100 = lineIndex % 100;

    if (mod100 >= 11 && mod100 <= 13) {
      return "th";
    }

    if (lineIndex % 10 === 1) {
      return "st";
    }

    if (lineIndex % 10 === 2) {
      return "nd";
    }

    if (lineIndex % 10 === 3) {
      return "rd";
    }

    return "th";
  }

  private static diagnoseAnchor(ref: string): string {
    const core = ref.replace(/^\s*[>+\-*]*\s*/u, "").trim();

    if (/^\d+\s*$/u.test(core)) {
      return `Invalid line reference "${ref}": missing hash, use "LINE+ID" from read output (e.g. "5sr").`;
    }

    if (/^\d+\s*#/u.test(core)) {
      return `Invalid line reference "${ref}": old LINE#HASH anchors are no longer accepted; use "LINE+ID|content" from read output.`;
    }

    if (/^\d+\s*:/u.test(core)) {
      return `Invalid line reference "${ref}": wrong separator, use "LINE+ID|content" from read output.`;
    }

    const hashMatch = core.match(/^(\d+)\s*([^\s|]+)(?:\|.*)?$/u);

    if (hashMatch !== null) {
      const line = Number.parseInt(hashMatch[1] ?? "", 10);
      const hash = hashMatch[2] ?? "";

      if (line < 1) {
        return `Line number must be >= 1, got ${line} in "${ref}".`;
      }

      if (hash.length !== 2) {
        return `Invalid line reference "${ref}": hash must be exactly 2 lowercase letters.`;
      }

      if (!Hashline.hashAlphabetPattern.test(hash)) {
        return `Invalid line reference "${ref}": hash uses invalid characters; use the lowercase two-letter ID from read output.`;
      }
    }

    return `Invalid line reference "${ref}": missing hash, use "LINE+ID" from read output (e.g. "5sr").`;
  }
}
