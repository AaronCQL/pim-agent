import { visibleWidth } from "@earendil-works/pi-tui";

export const SEP_RIGHT = "";
export const SEP_LEFT = "";
export const SEP_THIN_LEFT = "";
export const GIT_ICON = "";
export const GIT_DIRTY_ICON = "";

export const RESET = "\x1b[0m";
export const BG_DEFAULT = "\x1b[49m";
export const REVERSE = "\x1b[7m";
export const RESET_REVERSE = "\x1b[27m";

export const FG_BLACK = "\x1b[30m";
export const FG_WHITE = "\x1b[97m";
export const BG_GRAY = "\x1b[100m";
export const BG_BRIGHT_RED = "\x1b[101m";
export const BG_BRIGHT_GREEN = "\x1b[102m";
export const BG_BRIGHT_YELLOW = "\x1b[103m";
export const BG_BRIGHT_MAGENTA = "\x1b[105m";

export const BG_TO_FG: Record<string, string> = {
  [BG_GRAY]: "\x1b[90m",
  [BG_BRIGHT_RED]: "\x1b[91m",
  [BG_BRIGHT_GREEN]: "\x1b[92m",
  [BG_BRIGHT_YELLOW]: "\x1b[93m",
  [BG_BRIGHT_MAGENTA]: "\x1b[95m",
};

export type Segment = {
  readonly text: string;
  readonly fg: string;
  readonly bg: string;
};

export function paint(seg: Segment): string {
  return `${seg.bg}${seg.fg} ${seg.text} ${RESET}`;
}

export function chevronRight(prev: Segment, next: Segment | null): string {
  const fg = BG_TO_FG[prev.bg]!;
  if (next === null) {
    return `${fg}${SEP_RIGHT}${RESET}`;
  }
  return `${fg}${next.bg}${SEP_RIGHT}${RESET}`;
}

export function chevronLeft(prev: Segment | null, next: Segment): string {
  const fg = BG_TO_FG[next.bg]!;
  if (prev === null) {
    return `${fg}${SEP_LEFT}${RESET}`;
  }
  return `${fg}${prev.bg}${SEP_LEFT}${RESET}`;
}

export function thinChevronLeft(bg: string, fg: string): string {
  return `${BG_DEFAULT}${BG_TO_FG[bg]}${REVERSE}${SEP_THIN_LEFT}${RESET_REVERSE}${bg}${fg}`;
}

export function renderLeftGroup(segs: readonly Segment[]): string {
  let out = "";
  for (let i = 0; i < segs.length; i++) {
    out += paint(segs[i]!);
    out += chevronRight(segs[i]!, segs[i + 1] ?? null);
  }
  return out;
}

export function renderRightGroup(segs: readonly Segment[]): string {
  let out = "";
  for (let i = 0; i < segs.length; i++) {
    out += chevronLeft(segs[i - 1] ?? null, segs[i]!);
    out += paint(segs[i]!);
  }
  return out;
}

export function groupWidth(segs: readonly Segment[]): number {
  let w = 0;
  for (const s of segs) {
    w += visibleWidth(s.text) + 3;
  }
  return w;
}
