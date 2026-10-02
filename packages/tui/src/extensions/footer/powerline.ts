import { visibleWidth } from "@earendil-works/pi-tui";

const SEP_RIGHT = "";
const SEP_LEFT = "";
const SEP_THIN_LEFT = "";

export const GIT_ICON = "";
export const GIT_DIRTY_ICON = "";
export const GIT_AHEAD_ICON = "";
export const GIT_BEHIND_ICON = "";

const RESET = "\x1b[0m";
const BG_DEFAULT = "\x1b[49m";
const REVERSE = "\x1b[7m";
const RESET_REVERSE = "\x1b[27m";

export const FG_BLACK = "\x1b[30m";
export const FG_WHITE = "\x1b[97m";
export const BG_GRAY = "\x1b[100m";
export const BG_BRIGHT_RED = "\x1b[101m";
export const BG_BRIGHT_GREEN = "\x1b[102m";
export const BG_BRIGHT_YELLOW = "\x1b[103m";
export const BG_BRIGHT_MAGENTA = "\x1b[105m";

const BG_TO_FG: Record<string, string> = {
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

function paint(seg: Segment): string {
  return `${seg.bg}${seg.fg} ${seg.text} ${RESET}`;
}

function chevronRight(prev: Segment, next: Segment | undefined): string {
  return `${BG_TO_FG[prev.bg]}${next?.bg ?? ""}${SEP_RIGHT}${RESET}`;
}

function chevronLeft(prev: Segment | undefined, next: Segment): string {
  return `${BG_TO_FG[next.bg]}${prev?.bg ?? ""}${SEP_LEFT}${RESET}`;
}

export function thinChevronLeft(bg: string, fg: string): string {
  return `${BG_DEFAULT}${BG_TO_FG[bg]}${REVERSE}${SEP_THIN_LEFT}${RESET_REVERSE}${bg}${fg}`;
}

export function renderLeftGroup(segs: readonly Segment[]): string {
  let out = "";
  for (let i = 0; i < segs.length; i++) {
    out += paint(segs[i]!);
    out += chevronRight(segs[i]!, segs[i + 1]);
  }
  return out;
}

export function renderRightGroup(segs: readonly Segment[]): string {
  let out = "";
  for (let i = 0; i < segs.length; i++) {
    out += chevronLeft(segs[i - 1], segs[i]!);
    out += paint(segs[i]!);
  }
  return out;
}

export function groupWidth(segs: readonly Segment[]): number {
  return segs.reduce((w, s) => w + visibleWidth(s.text) + 3, 0);
}
