import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { GitState } from "#core/shared/Git";
import { GitMonitor } from "#core/shared/GitMonitor";
import { renderFooterLine } from "./segments";

let activeGitRefresh: (() => void) | null = null;

type FooterTui = Pick<TUI, "requestRender">;
type FooterData = Pick<ReadonlyFooterDataProvider, "onBranchChange">;
type FooterWidget = Component & { readonly dispose: () => void };

type FooterWidgetDeps = {
  readonly renderFooterLine: (
    width: number,
    ctx: ExtensionContext,
    gitState: GitState,
    cost: number
  ) => string;
  readonly getTotalCost: (ctx: ExtensionContext) => number;
};

const DEFAULT_FOOTER_WIDGET_DEPS: FooterWidgetDeps = {
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
  monitor: GitMonitor,
  deps: FooterWidgetDeps = DEFAULT_FOOTER_WIDGET_DEPS
): FooterWidget {
  const refresh = (): void => {
    void monitor.refresh(ctx.cwd);
  };
  // The monitor holds the state; a copy here would be a second one to keep.
  const unwatch = monitor.watch(ctx.cwd, () => {
    tui.requestRender();
  });
  const unsubBranch = footerData.onBranchChange(refresh);
  activeGitRefresh = refresh;
  return {
    invalidate(): void {},
    render(width: number): string[] {
      return [
        deps.renderFooterLine(
          width,
          ctx,
          monitor.stateOf(ctx.cwd),
          deps.getTotalCost(ctx)
        ),
      ];
    },
    dispose(): void {
      unsubBranch();
      unwatch();
      activeGitRefresh = null;
    },
  };
}

export default function (pi: ExtensionAPI): void {
  const monitor = new GitMonitor();
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) {
      return;
    }
    ctx.ui.setFooter((tui, _theme, footerData) =>
      createFooterWidget(ctx, tui, footerData, monitor)
    );
  });

  pi.on("tool_execution_end", () => {
    activeGitRefresh?.();
  });
}
