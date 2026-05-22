import { describe, expect, test } from "bun:test";
import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { TodoItem } from "./schema";
import {
  formatCallTitle,
  formatWidgetTitle,
  renderCall,
  renderResult,
  renderWidgetLines,
} from "./render";
import { makeDetails } from "./todo";

const items: readonly TodoItem[] = [
  { content: "Plan", status: "pending" },
  { content: "Build", status: "in_progress" },
  { content: "Verify", status: "completed" },
  { content: "Skip", status: "cancelled" },
];

const stubTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `**${text}**`,
  strikethrough: (text: string) => `~~${text}~~`,
} as unknown as Theme;

const expandedOptions = {
  expanded: true,
  isPartial: false,
} as ToolRenderResultOptions;
const context = {
  lastComponent: undefined,
  isPartial: false,
  isError: false,
};

describe("todo render", () => {
  test("renderCall shows only the compact status summary", () => {
    expect(formatCallTitle(items)).toBe("1 done, 2 pending, 1 cancelled");
    const rendered = renderCall({ todos: items }, stubTheme, context).render(
      120
    )[0];
    expect(rendered).toContain("**Todo**");
    expect(rendered).toContain("1 done, 2 pending, 1 cancelled");
  });

  test("renderResult is hidden so the widget is the only TUI checklist", () => {
    expect(
      renderResult(
        toolResult(items),
        expandedOptions,
        stubTheme,
        context
      ).render(120)
    ).toEqual([]);
  });

  test("widget title bolds total and wraps status summary", () => {
    const pendingItems: readonly TodoItem[] = [
      { content: "One", status: "pending" },
      { content: "Two", status: "pending" },
      { content: "Three", status: "pending" },
      { content: "Four", status: "pending" },
    ];

    expect(formatWidgetTitle(pendingItems, stubTheme)).toBe(
      "**4 todos** (4 pending)"
    );
  });

  test("widget colours only status markers", () => {
    const lines = renderWidgetLines(items, stubTheme);

    expect(formatWidgetTitle(items, stubTheme)).toBe(
      "**4 todos** (1 done, 2 pending, 1 cancelled)"
    );
    expect(lines).toEqual([
      "**4 todos** (1 done, 2 pending, 1 cancelled)",
      "□ Plan",
      "<warning>➤</warning> **Build**",
      "<success>✔</success> <muted>Verify</muted>",
      "<muted>✘</muted> <muted>~~Skip~~</muted>",
    ]);
  });

  test("widget shows all rows instead of trading one todo for a +1 hint", () => {
    const many = makePendingItems(6);

    const lines = renderWidgetLines(many, stubTheme);

    expect(lines).toHaveLength(7);
    expect(lines.slice(1)).toEqual([
      "□ Task 1",
      "□ Task 2",
      "□ Task 3",
      "□ Task 4",
      "□ Task 5",
      "□ Task 6",
    ]);
  });

  test("widget caps rows with a muted hidden-count hint", () => {
    const many = makePendingItems(10);

    const lines = renderWidgetLines(many, stubTheme);

    expect(lines).toHaveLength(7);
    expect(lines.slice(1, -1)).toEqual([
      "□ Task 1",
      "□ Task 2",
      "□ Task 3",
      "□ Task 4",
      "□ Task 5",
    ]);
    expect(lines.at(-1)).toBe("<muted>… +5 more</muted>");
  });

  test("widget centers the visible rows around the in-progress item", () => {
    const many = makePendingItems(50, { index: 24, status: "in_progress" });

    const lines = renderWidgetLines(many, stubTheme);

    expect(lines).toHaveLength(7);
    expect(lines.slice(1, -1)).toEqual([
      "□ Task 23",
      "□ Task 24",
      "<warning>➤</warning> **Task 25**",
      "□ Task 26",
      "□ Task 27",
    ]);
    expect(lines.at(-1)).toBe("<muted>… +45 more</muted>");
  });

  test("widget falls back to the last non-pending item when none are in progress", () => {
    const many = makePendingItems(12, { index: 6, status: "completed" });

    const lines = renderWidgetLines(many, stubTheme);

    expect(lines.slice(1, -1)).toEqual([
      "□ Task 5",
      "□ Task 6",
      "<success>✔</success> <muted>Task 7</muted>",
      "□ Task 8",
      "□ Task 9",
    ]);
    expect(lines.at(-1)).toBe("<muted>… +7 more</muted>");
  });
});

function toolResult(
  items: readonly TodoItem[]
): AgentToolResult<ReturnType<typeof makeDetails>> {
  return {
    content: [{ type: "text", text: "" }],
    details: makeDetails(items),
  };
}

function makePendingItems(
  count: number,
  override?: { readonly index: number; readonly status: TodoItem["status"] }
): readonly TodoItem[] {
  return Array.from({ length: count }, (_, index) => ({
    content: `Task ${index + 1}`,
    status: override?.index === index ? override.status : "pending",
  }));
}
