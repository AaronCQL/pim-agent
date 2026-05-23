import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Tools } from "../../shared/Tools";
import { renderCall, renderResult, renderWidgetLines } from "./render";
import { todoSchema } from "./schema";
import {
  formatChecklist,
  getCurrentItems,
  hasActiveItems,
  makeDetails,
  reconstructFromBranch,
  replaceItems,
  resetItems,
  TODO_STATE_CUSTOM_TYPE,
} from "./todo";

const WIDGET_ID = "pim-todo";

export default function (pi: ExtensionAPI): void {
  const refreshWidget = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) {
      return;
    }
    const items = getCurrentItems();
    if (items.length === 0) {
      ctx.ui.setWidget(WIDGET_ID, undefined);
      return;
    }
    ctx.ui.setWidget(WIDGET_ID, renderWidgetLines(items, ctx.ui.theme));
  };

  const reconstructAndRefresh = (ctx: ExtensionContext): void => {
    reconstructFromBranch(ctx.sessionManager.getBranch());
    refreshWidget(ctx);
  };

  const clearInactiveTodos = (ctx: ExtensionContext): void => {
    const items = getCurrentItems();
    if (items.length === 0 || hasActiveItems(items)) {
      return;
    }

    resetItems();
    refreshWidget(ctx);
  };

  Tools.register(pi, {
    name: "todo",
    label: "todo",
    description:
      "Manage your to-dos. ALWAYS use for tasks with 3+ steps; skip only for trivial one-step tasks. " +
      "Each call replaces the entire list; include every item in priority order. " +
      "Keep at most one item in_progress, mark items completed immediately after finishing, and preserve skipped work as cancelled.",
    parameters: todoSchema,
    renderShell: "self",
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const items = replaceItems(params.todos);
      return {
        content: [
          {
            type: "text",
            text: formatChecklist(items),
          },
        ],
        details: makeDetails(items),
      };
    },
    renderCall,
    renderResult,
  });

  pi.on("session_start", (_event, ctx) => {
    reconstructAndRefresh(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    reconstructAndRefresh(ctx);
  });

  pi.on("turn_end", (_event, ctx) => {
    refreshWidget(ctx);
  });

  pi.on("input", (_event, ctx) => {
    clearInactiveTodos(ctx);
    return { action: "continue" };
  });

  pi.on("session_compact", () => {
    const items = getCurrentItems();
    if (items.length === 0) {
      return;
    }
    pi.appendEntry(TODO_STATE_CUSTOM_TYPE, { todos: items });
    const snapshot = formatChecklist(items, { activeOnly: true });
    if (!snapshot) {
      return;
    }
    pi.sendMessage(
      {
        customType: "pim-todo-snapshot",
        content: `Current todo list:\n${snapshot}`,
        display: false,
      },
      { triggerTurn: false }
    );
  });
}
