export type SplitMode = "auto" | "split" | "unified";

/** Pane width (not window width) below which `auto` goes unified. */
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
