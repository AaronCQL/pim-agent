/** How a file's hunks are laid out: old beside new, or one column of both. */
export type SplitMode = "auto" | "split" | "unified";

/**
 * Measured pane width below which side beside side stops being worth its
 * columns. A long line wraps inside its half rather than widening it, so this
 * is the width at which half of it still holds a typical line before wrapping,
 * not the width the longest line needs.
 */
const SPLIT_MIN_REM = 56.25;

const MODES: readonly SplitMode[] = ["auto", "split", "unified"];

function parse(value: unknown): SplitMode {
  return MODES.includes(value as SplitMode) ? (value as SplitMode) : "auto";
}

function rem(): number {
  const size = Number.parseFloat(
    getComputedStyle(document.documentElement).fontSize
  );
  return Number.isFinite(size) && size > 0 ? size : 16;
}

function split(mode: SplitMode, width: number): boolean {
  return mode === "auto" ? width >= SPLIT_MIN_REM * rem() : mode === "split";
}

export const SplitMode = { parse, split };
