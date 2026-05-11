import type {
  ExtensionContext,
  ThinkingLevelChangeEntry,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Paths } from "../../shared/Paths";
import type { GitState } from "./git";
import {
  BG_BRIGHT_GREEN,
  BG_BRIGHT_MAGENTA,
  BG_BRIGHT_RED,
  BG_BRIGHT_YELLOW,
  BG_GRAY,
  FG_BLACK,
  FG_WHITE,
  GIT_DIRTY_ICON,
  GIT_ICON,
  groupWidth,
  renderLeftGroup,
  renderRightGroup,
  type Segment,
  thinChevronLeft,
} from "./powerline";

function formatTokens(n: number): string {
  if (n < 1000) {
    return `${n}`;
  }
  if (n < 10_000) {
    return `${(n / 1000).toFixed(1)}K`;
  }
  if (n < 1_000_000) {
    return `${Math.round(n / 1000)}K`;
  }
  if (n < 10_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  return `${Math.round(n / 1_000_000)}M`;
}

function gitSegment(state: GitState): Segment | null {
  const { branch, dirty, ahead, behind } = state;
  if (!branch) {
    return null;
  }
  let text = `${GIT_ICON} ${branch}`;
  if (dirty) {
    text += ` ${GIT_DIRTY_ICON}`;
  }
  if (ahead > 0 || behind > 0) {
    let arrows = " ";
    if (ahead > 0) {
      arrows += `${ahead}`;
    }
    if (behind > 0) {
      arrows += `${behind}`;
    }
    text += arrows;
  }
  const bg =
    behind > 0 ? BG_BRIGHT_RED : dirty ? BG_BRIGHT_YELLOW : BG_BRIGHT_GREEN;
  return { text, fg: FG_BLACK, bg };
}

function ctxSegment(ctx: ExtensionContext): Segment | null {
  const usage = ctx.getContextUsage();
  if (!usage || usage.contextWindow === 0) {
    return null;
  }
  const window = formatTokens(usage.contextWindow);
  const text =
    usage.percent === null
      ? `?/${window}`
      : `${usage.percent.toFixed(0)}%/${window}`;
  const percent = usage.percent ?? 0;
  const bg =
    percent >= 70
      ? BG_BRIGHT_RED
      : percent > 40
        ? BG_BRIGHT_YELLOW
        : BG_BRIGHT_GREEN;
  return { text, fg: FG_BLACK, bg };
}

function costSegment(cost: number): Segment | null {
  if (cost <= 0) {
    return null;
  }
  return {
    text: `$${cost.toFixed(2)}`,
    fg: FG_BLACK,
    bg: BG_BRIGHT_MAGENTA,
  };
}

const LEVEL_LABEL: Record<string, string> = { minimal: "min", medium: "med" };

function findLatestThinkingLevel(ctx: ExtensionContext): string {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type === "thinking_level_change") {
      return (entry as ThinkingLevelChangeEntry).thinkingLevel;
    }
  }
  return "off";
}

function modelSegment(ctx: ExtensionContext): Segment | null {
  const id = ctx.model?.id;
  if (!id) {
    return null;
  }

  if (ctx.model?.reasoning) {
    const level = findLatestThinkingLevel(ctx);
    const label = LEVEL_LABEL[level] ?? level;
    return {
      text: `${id} ${thinChevronLeft(BG_GRAY, FG_WHITE)} ${label}`,
      fg: FG_WHITE,
      bg: BG_GRAY,
    };
  }

  return { text: id, fg: FG_WHITE, bg: BG_GRAY };
}

function compact<T>(items: readonly (T | null)[]): T[] {
  return items.filter((x): x is T => x !== null);
}

const bold = (s: string): string => `\x1b[1m${s}\x1b[22m`;

function formatCwd(path: string): string {
  if (path === "/" || path === "~") {
    return bold(path);
  }
  const parts = path.split("/");
  const last = parts.pop()!;
  const abbrParent = parts
    .map((p) => {
      if (p === "" || p === "~") {
        return p;
      }
      return p.startsWith(".") && p.length > 1 ? p.slice(0, 2) : p[0]!;
    })
    .join("/");
  return `${abbrParent}/${bold(last)}`;
}

export function renderFooterLine(
  width: number,
  ctx: ExtensionContext,
  gitState: GitState,
  cost: number
): string {
  const cwd: Segment = {
    text: formatCwd(Paths.abbreviateHome(ctx.sessionManager.getCwd())),
    fg: FG_WHITE,
    bg: BG_GRAY,
  };
  const branch = gitSegment(gitState);
  const costSeg = costSegment(cost);
  const ctxSeg = ctxSegment(ctx);
  const model = modelSegment(ctx);

  const fullLeft = compact([cwd, branch]);
  const fullLeftWidth = groupWidth(fullLeft);
  const candidates: readonly { left: Segment[]; right: Segment[] }[] = [
    { left: fullLeft, right: compact([costSeg, ctxSeg, model]) },
    { left: fullLeft, right: compact([costSeg, ctxSeg]) },
    { left: fullLeft, right: compact([ctxSeg]) },
    { left: [cwd], right: compact([ctxSeg]) },
  ];

  let chosen = candidates[candidates.length - 1]!;
  let chosenLeftWidth = groupWidth(chosen.left);
  let chosenRightWidth = groupWidth(chosen.right);
  for (const c of candidates) {
    const lw = c.left === fullLeft ? fullLeftWidth : groupWidth(c.left);
    const rw = groupWidth(c.right);
    if (lw + rw + 1 <= width) {
      chosen = c;
      chosenLeftWidth = lw;
      chosenRightWidth = rw;
      break;
    }
  }

  let left = chosen.left;
  let leftWidth = chosenLeftWidth;
  if (leftWidth + chosenRightWidth + 1 > width && left.length > 0) {
    const overflow = leftWidth + chosenRightWidth + 1 - width;
    const newCwdWidth = Math.max(3, visibleWidth(left[0]!.text) - overflow);
    const truncated: Segment = {
      ...left[0]!,
      text: truncateToWidth(left[0]!.text, newCwdWidth, "…"),
    };
    left = [truncated, ...left.slice(1)];
    leftWidth =
      leftWidth -
      visibleWidth(chosen.left[0]!.text) +
      visibleWidth(truncated.text);
  }

  const gap = Math.max(1, width - leftWidth - chosenRightWidth);
  return (
    renderLeftGroup(left) + " ".repeat(gap) + renderRightGroup(chosen.right)
  );
}
