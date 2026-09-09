import type {
  ExtensionContext,
  ThinkingLevelChangeEntry,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Format } from "#core/shared/Format";
import { Paths } from "#core/shared/Paths";
import type { GitState } from "#core/shared/Git";
import {
  BG_BRIGHT_GREEN,
  BG_BRIGHT_MAGENTA,
  BG_BRIGHT_RED,
  BG_BRIGHT_YELLOW,
  BG_GRAY,
  FG_BLACK,
  FG_WHITE,
  GIT_AHEAD_ICON,
  GIT_BEHIND_ICON,
  GIT_DIRTY_ICON,
  GIT_ICON,
  groupWidth,
  renderLeftGroup,
  renderRightGroup,
  type Segment,
  thinChevronLeft,
} from "./powerline";

function gitSegment(state: GitState): Segment | null {
  const { branch, dirtyCount, ahead, behind } = state;
  if (!branch) {
    return null;
  }
  let text = `${GIT_ICON} ${branch}`;
  if (dirtyCount > 0) {
    text += ` ${GIT_DIRTY_ICON}${dirtyCount}`;
  }
  if (ahead > 0 || behind > 0) {
    let arrows = " ";
    if (ahead > 0) {
      arrows += `${GIT_AHEAD_ICON}${ahead}`;
    }
    if (behind > 0) {
      arrows += `${GIT_BEHIND_ICON}${behind}`;
    }
    text += arrows;
  }
  const bg =
    behind > 0
      ? BG_BRIGHT_RED
      : dirtyCount > 0
        ? BG_BRIGHT_YELLOW
        : BG_BRIGHT_GREEN;
  return { text, fg: FG_BLACK, bg };
}

function ctxSegment(ctx: ExtensionContext): Segment | null {
  const usage = ctx.getContextUsage();
  if (!usage || usage.contextWindow === 0) {
    return null;
  }
  const window = Format.formatTokens(usage.contextWindow);
  const text =
    usage.percent === null
      ? `?/${window}`
      : `${usage.percent.toFixed(1)}%/${window}`;
  const bg = {
    full: BG_BRIGHT_RED,
    warn: BG_BRIGHT_YELLOW,
    ok: BG_BRIGHT_GREEN,
  }[Format.contextFill(usage.percent ?? 0)];
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

function fitLine(line: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  return visibleWidth(line) <= width ? line : truncateToWidth(line, width, "");
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
  const candidates: readonly { left: Segment[]; right: Segment[] }[] = [
    { left: fullLeft, right: compact([costSeg, ctxSeg, model]) },
    { left: fullLeft, right: compact([costSeg, ctxSeg]) },
    { left: fullLeft, right: compact([ctxSeg]) },
    { left: [cwd], right: compact([ctxSeg]) },
    { left: [cwd], right: [] },
  ];

  const gapOf = (c: { left: Segment[]; right: Segment[] }): number =>
    c.left.length > 0 && c.right.length > 0 ? 1 : 0;
  const fits = (c: { left: Segment[]; right: Segment[] }): boolean =>
    groupWidth(c.left) + groupWidth(c.right) + gapOf(c) <= width;

  const chosen = candidates.find(fits) ?? candidates.at(-1)!;
  const rightWidth = groupWidth(chosen.right);

  let left = chosen.left;
  let leftWidth = groupWidth(left);
  const requiredWidth = leftWidth + rightWidth + gapOf(chosen);
  if (requiredWidth > width && left.length > 0) {
    const overflow = requiredWidth - width;
    const newCwdWidth = Math.max(0, visibleWidth(left[0]!.text) - overflow);
    const truncated: Segment = {
      ...left[0]!,
      text: truncateToWidth(left[0]!.text, newCwdWidth, "…"),
    };
    left = [truncated, ...left.slice(1)];
    leftWidth = groupWidth(left);
  }

  const gap =
    left.length > 0 && chosen.right.length > 0
      ? Math.max(1, width - leftWidth - rightWidth)
      : 0;
  return fitLine(
    renderLeftGroup(left) + " ".repeat(gap) + renderRightGroup(chosen.right),
    width
  );
}
