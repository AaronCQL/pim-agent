import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Tools } from "../../shared/Tools";
import { renderCall, renderResult, renderWidgetLines } from "./render";
import { todoSchema } from "./schema";
import {
  formatChecklist,
  formatUpdateSummary,
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
  let pendingRefresh: ReturnType<typeof setImmediate> | undefined;

  const refreshWidget = (ctx: ExtensionContext): void => {
    if (pendingRefresh !== undefined) {
      clearImmediate(pendingRefresh);
      pendingRefresh = undefined;
    }
    if (!ctx.hasUI) {
      return;
    }
    const items = getCurrentItems(ctx.sessionManager);
    if (items.length === 0) {
      ctx.ui.setWidget(WIDGET_ID, undefined);
      return;
    }
    // Defer so todo widget is always the last widget to show up (right above editor)
    pendingRefresh = setImmediate(() => {
      pendingRefresh = undefined;
      ctx.ui.setWidget(WIDGET_ID, renderWidgetLines(items, ctx.ui.theme));
    });
  };

  const reconstructAndRefresh = (ctx: ExtensionContext): void => {
    reconstructFromBranch(ctx.sessionManager, ctx.sessionManager.getBranch());
    refreshWidget(ctx);
  };

  const clearInactiveTodos = (ctx: ExtensionContext): void => {
    const items = getCurrentItems(ctx.sessionManager);
    if (items.length === 0 || hasActiveItems(items)) {
      return;
    }

    resetItems(ctx.sessionManager);
    refreshWidget(ctx);
  };

  Tools.register(pi, {
    name: "todo",
    label: "todo",
    description:
      "Update the session task list. " +
      "Each call replaces the entire list; include every item that should remain, in priority order. " +
      "Status values are pending, in_progress, completed, and cancelled. " +
      "At most one item may be in_progress.",
    parameters: todoSchema,
    renderShell: "self",
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const items = replaceItems(ctx.sessionManager, params.todos);
      return {
        content: [
          {
            type: "text",
            text: formatUpdateSummary(items),
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

  pi.on("session_compact", (_event, ctx) => {
    const items = getCurrentItems(ctx.sessionManager);
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
