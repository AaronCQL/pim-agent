import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ThinkingLevelChangeEntry,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Paths } from "../../shared/Paths";
import { PimSettings } from "../../shared/PimSettings";

const SEP_RIGHT = "";
const SEP_LEFT = "";
const SEP_THIN_LEFT = "";

const RESET = "\x1b[0m";
const BG_DEFAULT = "\x1b[49m";
const REVERSE = "\x1b[7m";
const RESET_REVERSE = "\x1b[27m";

const FG_BLACK = "\x1b[30m";
const FG_WHITE = "\x1b[97m";
const BG_GRAY = "\x1b[100m";
const BG_BRIGHT_RED = "\x1b[101m";
const BG_BRIGHT_GREEN = "\x1b[102m";
const BG_BRIGHT_YELLOW = "\x1b[103m";
const BG_BRIGHT_MAGENTA = "\x1b[105m";

const BG_TO_FG: Record<string, string> = {
  [BG_GRAY]: "\x1b[90m",
  [BG_BRIGHT_RED]: "\x1b[91m",
  [BG_BRIGHT_GREEN]: "\x1b[92m",
  [BG_BRIGHT_YELLOW]: "\x1b[93m",
  [BG_BRIGHT_MAGENTA]: "\x1b[95m",
};

type Segment = {
  readonly text: string;
  readonly fg: string;
  readonly bg: string;
};

type GitState = {
  readonly branch: string | null;
  readonly dirty: boolean;
  readonly ahead: number;
  readonly behind: number;
};

const EMPTY_GIT: GitState = { branch: null, dirty: false, ahead: 0, behind: 0 };

let cachedCost = 0;
let activeGitRefresh: (() => void) | null = null;

function recomputeCost(ctx: ExtensionContext): void {
  let cost = 0;
  for (const e of ctx.sessionManager.getBranch()) {
    if (e.type === "message" && e.message.role === "assistant") {
      cost += (e.message as AssistantMessage).usage.cost.total;
    }
  }
  cachedCost = cost;
}

function paint(seg: Segment): string {
  return `${seg.bg}${seg.fg} ${seg.text} ${RESET}`;
}

function chevronRight(prev: Segment, next: Segment | null): string {
  const fg = BG_TO_FG[prev.bg]!;
  if (next === null) {
    return `${fg}${SEP_RIGHT}${RESET}`;
  }
  return `${fg}${next.bg}${SEP_RIGHT}${RESET}`;
}

function chevronLeft(prev: Segment | null, next: Segment): string {
  const fg = BG_TO_FG[next.bg]!;
  if (prev === null) {
    return `${fg}${SEP_LEFT}${RESET}`;
  }
  return `${fg}${prev.bg}${SEP_LEFT}${RESET}`;
}

function thinChevronLeft(bg: string, fg: string): string {
  return `${BG_DEFAULT}${BG_TO_FG[bg]}${REVERSE}${SEP_THIN_LEFT}${RESET_REVERSE}${bg}${fg}`;
}

function renderLeftGroup(segs: readonly Segment[]): string {
  let out = "";
  for (let i = 0; i < segs.length; i++) {
    out += paint(segs[i]!);
    out += chevronRight(segs[i]!, segs[i + 1] ?? null);
  }
  return out;
}

function renderRightGroup(segs: readonly Segment[]): string {
  let out = "";
  for (let i = 0; i < segs.length; i++) {
    out += chevronLeft(segs[i - 1] ?? null, segs[i]!);
    out += paint(segs[i]!);
  }
  return out;
}

function groupWidth(segs: readonly Segment[]): number {
  let w = 0;
  for (const s of segs) {
    w += visibleWidth(s.text) + 3;
  }
  return w;
}

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
  let text = ` ${branch}`;
  if (dirty) {
    text += " ";
  }
  if (ahead > 0 || behind > 0) {
    let arrows = " ";
    if (ahead > 0) {
      arrows += `${ahead}`;
    }
    if (behind > 0) {
      arrows += `${behind}`;
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
    percent > 90
      ? BG_BRIGHT_RED
      : percent > 70
        ? BG_BRIGHT_YELLOW
        : BG_BRIGHT_GREEN;
  return { text, fg: FG_BLACK, bg };
}

function costSegment(): Segment | null {
  if (cachedCost <= 0) {
    return null;
  }
  return {
    text: `$${cachedCost.toFixed(2)}`,
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

function formatCwd(path: string): string {
  const bold = (s: string): string => `\x1b[1m${s}\x1b[22m`;
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

function renderFooterLine(
  width: number,
  ctx: ExtensionContext,
  gitState: GitState
): string {
  const cwd: Segment = {
    text: formatCwd(Paths.abbreviateHome(ctx.sessionManager.getCwd())),
    fg: FG_WHITE,
    bg: BG_GRAY,
  };
  const branch = gitSegment(gitState);
  const cost = costSegment();
  const ctxSeg = ctxSegment(ctx);
  const model = modelSegment(ctx);

  const candidates: readonly { left: Segment[]; right: Segment[] }[] = [
    { left: compact([cwd, branch]), right: compact([cost, ctxSeg, model]) },
    { left: compact([cwd, branch]), right: compact([cost, ctxSeg]) },
    { left: compact([cwd, branch]), right: compact([ctxSeg]) },
    { left: [cwd], right: compact([ctxSeg]) },
  ];

  let chosen = candidates[candidates.length - 1]!;
  for (const c of candidates) {
    if (groupWidth(c.left) + groupWidth(c.right) + 1 <= width) {
      chosen = c;
      break;
    }
  }

  let left = chosen.left;
  const total = groupWidth(left) + groupWidth(chosen.right);
  if (total + 1 > width && left.length > 0) {
    const overflow = total + 1 - width;
    const newCwdWidth = Math.max(3, visibleWidth(left[0]!.text) - overflow);
    left = [
      {
        ...left[0]!,
        text: truncateToWidth(left[0]!.text, newCwdWidth, "…"),
      },
      ...left.slice(1),
    ];
  }

  const leftStr = renderLeftGroup(left);
  const rightStr = renderRightGroup(chosen.right);
  const finalTotal = groupWidth(left) + groupWidth(chosen.right);
  const gap = Math.max(1, width - finalTotal);
  return leftStr + " ".repeat(gap) + rightStr;
}

async function fetchGitStatus(cwd: string): Promise<GitState> {
  try {
    const proc = Bun.spawn(["git", "status", "--porcelain=v2", "--branch"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) {
      return EMPTY_GIT;
    }
    let branch: string | null = null;
    let ahead = 0;
    let behind = 0;
    let dirty = false;
    for (const line of text.split("\n")) {
      if (line.startsWith("# branch.head ")) {
        const head = line.slice("# branch.head ".length);
        branch = head === "(detached)" ? "detached" : head;
      } else if (line.startsWith("# branch.ab ")) {
        const m = /\+(\d+)\s+-(\d+)/.exec(line);
        if (m) {
          ahead = Number(m[1]);
          behind = Number(m[2]);
        }
      } else if (line.length > 0 && !line.startsWith("#")) {
        dirty = true;
      }
    }
    return { branch, dirty, ahead, behind };
  } catch {
    return EMPTY_GIT;
  }
}

function installFooter(ctx: ExtensionContext): void {
  if (!ctx.hasUI) {
    return;
  }
  ctx.ui.setFooter((tui, _theme, footerData) => {
    let gitState: GitState = EMPTY_GIT;
    const refresh = async (): Promise<void> => {
      const next = await fetchGitStatus(ctx.cwd);
      if (
        next.branch !== gitState.branch ||
        next.dirty !== gitState.dirty ||
        next.ahead !== gitState.ahead ||
        next.behind !== gitState.behind
      ) {
        gitState = next;
        tui.requestRender();
      }
    };
    void refresh();
    const unsubBranch = footerData.onBranchChange(() => {
      void refresh();
    });
    activeGitRefresh = () => {
      void refresh();
    };
    return {
      invalidate(): void {},
      render(width: number): string[] {
        return [renderFooterLine(width, ctx, gitState)];
      },
      dispose(): void {
        unsubBranch();
        activeGitRefresh = null;
      },
    };
  });
}

export default function (pi: ExtensionAPI): void {
  const apply = async (ctx: ExtensionContext): Promise<void> => {
    if (!ctx.hasUI) {
      return;
    }
    const { enabled } = await PimSettings.get("powerline");
    if (enabled) {
      installFooter(ctx);
    } else {
      ctx.ui.setFooter(undefined);
    }
  };

  pi.registerCommand("powerline", {
    description: "Toggle the pim powerline footer",
    handler: async (_args, ctx) => {
      const current = await PimSettings.get("powerline");
      const next = { ...current, enabled: !current.enabled };
      await PimSettings.set("powerline", next);
      await apply(ctx);
      ctx.ui.notify(
        `Pim powerline footer ${next.enabled ? "enabled" : "disabled"}`,
        "info"
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    recomputeCost(ctx);
    await apply(ctx);
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") {
      cachedCost += event.message.usage.cost.total;
    }
  });

  pi.on("tool_execution_end", () => {
    activeGitRefresh?.();
  });
}
