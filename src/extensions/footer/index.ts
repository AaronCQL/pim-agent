import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { PimSettings } from "../../shared/PimSettings";
import { EMPTY_GIT, fetchGitStatus, type GitState, watchGitDir } from "./git";
import { renderFooterLine } from "./segments";

let activeGitRefresh: (() => void) | null = null;

type FooterTui = Pick<TUI, "requestRender">;
type FooterData = Pick<ReadonlyFooterDataProvider, "onBranchChange">;
type FooterWidget = Component & { readonly dispose: () => void };

type FooterWidgetDeps = {
  readonly fetchGitStatus: (cwd: string) => Promise<GitState>;
  readonly watchGitDir: (cwd: string, onChange: () => void) => () => void;
  readonly renderFooterLine: (
    width: number,
    ctx: ExtensionContext,
    gitState: GitState,
    cost: number
  ) => string;
  readonly getTotalCost: (ctx: ExtensionContext) => number;
};

const DEFAULT_FOOTER_WIDGET_DEPS: FooterWidgetDeps = {
  fetchGitStatus,
  watchGitDir,
  renderFooterLine,
  getTotalCost,
};

export function getTotalCost(ctx: ExtensionContext): number {
  let cost = 0;
  for (const e of ctx.sessionManager.getEntries()) {
    if (e.type === "message" && e.message.role === "assistant") {
      cost += (e.message as AssistantMessage).usage.cost.total;
    }
  }
  return cost;
}

export function createFooterWidget(
  ctx: ExtensionContext,
  tui: FooterTui,
  footerData: FooterData,
  deps: FooterWidgetDeps = DEFAULT_FOOTER_WIDGET_DEPS
): FooterWidget {
  let gitState: GitState = EMPTY_GIT;
  let inFlight = false;
  let pending = false;
  const refresh = async (): Promise<void> => {
    if (inFlight) {
      pending = true;
      return;
    }
    inFlight = true;
    try {
      do {
        pending = false;
        const next = await deps.fetchGitStatus(ctx.cwd);
        if (
          next.branch !== gitState.branch ||
          next.dirty !== gitState.dirty ||
          next.ahead !== gitState.ahead ||
          next.behind !== gitState.behind
        ) {
          gitState = next;
          tui.requestRender();
        }
      } while (pending);
    } finally {
      inFlight = false;
    }
  };
  void refresh();
  const unsubBranch = footerData.onBranchChange(() => {
    void refresh();
  });
  const disposeGitWatch = deps.watchGitDir(ctx.cwd, () => {
    void refresh();
  });
  activeGitRefresh = () => {
    void refresh();
  };
  return {
    invalidate(): void {},
    render(width: number): string[] {
      return [
        deps.renderFooterLine(width, ctx, gitState, deps.getTotalCost(ctx)),
      ];
    },
    dispose(): void {
      unsubBranch();
      disposeGitWatch();
      activeGitRefresh = null;
    },
  };
}

function installFooter(ctx: ExtensionContext): void {
  if (!ctx.hasUI) {
    return;
  }
  ctx.ui.setFooter((tui, _theme, footerData) => {
    return createFooterWidget(ctx, tui, footerData);
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
    await apply(ctx);
  });

  pi.on("tool_execution_end", () => {
    activeGitRefresh?.();
  });
}
