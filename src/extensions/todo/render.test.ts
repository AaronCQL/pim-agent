import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { AnsiPainter } from "../../shared/view/AnsiPainter";
import type { TodoItem } from "./schema";
import {
  formatWidgetTitle,
  renderWidgetLines,
  type TodoViewInput,
  todoView,
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

describe("todo view model", () => {
  test("title is the compact status summary", () => {
    const view = todoView(viewInput({ todos: items }, makeDetails(items)));

    expect(view.label).toBe("Todo");
    expect(title(view)).toBe("1 done, 2 pending, 1 cancelled");
  });

  test("title shows cleared when the todo list is empty", () => {
    expect(title(todoView(viewInput({ todos: [] })))).toBe("cleared");
  });

  test("title renders from partial args alone", () => {
    expect(title(todoView(viewInput({})))).toBe("cleared");
    expect(title(todoView(viewInput({ todos: [items[1]!] })))).toBe(
      "1 pending"
    );
  });

  test("body stays empty so the widget is the only TUI checklist", () => {
    expect(
      todoView(viewInput({ todos: items }, makeDetails(items))).body
    ).toBeUndefined();
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

function viewInput(
  args: { readonly todos?: readonly TodoItem[] },
  details?: ReturnType<typeof makeDetails>
): TodoViewInput {
  return {
    args: args as TodoViewInput["args"],
    ...(details === undefined
      ? {}
      : { result: { content: [{ type: "text", text: "" }], details } }),
    cwd: "/repo",
  };
}

function title(view: ReturnType<typeof todoView>): string {
  return AnsiPainter.paint(view.title, stubTheme).join(" ");
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
