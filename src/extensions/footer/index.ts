import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { PimSettings } from "../../shared/PimSettings";
import { EMPTY_GIT, fetchGitStatus, type GitState, watchGitDir } from "./git";
import { renderFooterLine } from "./segments";

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

function installFooter(ctx: ExtensionContext): void {
  if (!ctx.hasUI) {
    return;
  }
  ctx.ui.setFooter((tui, _theme, footerData) => {
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
        } while (pending);
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const unsubBranch = footerData.onBranchChange(() => {
      void refresh();
    });
    const disposeGitWatch = watchGitDir(ctx.cwd, () => {
      void refresh();
    });
    activeGitRefresh = () => {
      void refresh();
    };
    return {
      invalidate(): void {},
      render(width: number): string[] {
        return [renderFooterLine(width, ctx, gitState, cachedCost)];
      },
      dispose(): void {
        unsubBranch();
        disposeGitWatch();
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
