import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ToolViewInput } from "../../shared/Tools";
import type { ToolView, ViewBlock } from "../../view/ViewBlock";
import type { TodoInput, TodoItem, todoSchema } from "./schema";
import type { TodoDetails } from "./todo";

const MAX_WIDGET_LINES = 7;
const WIDGET_TITLE_LINES = 1;
const WIDGET_HINT_LINES = 1;
const MAX_UNTRUNCATED_WIDGET_TODOS = MAX_WIDGET_LINES - WIDGET_TITLE_LINES;
const MAX_TRUNCATED_WIDGET_TODOS =
  MAX_UNTRUNCATED_WIDGET_TODOS - WIDGET_HINT_LINES;
const WIDGET_ANCHOR_SLOT = Math.floor(MAX_WIDGET_LINES / 2) - 1;

export type TodoViewInput = ToolViewInput<typeof todoSchema, TodoDetails>;

/**
 * The checklist itself stays out of the view: it lives in the persistent
 * widget, so a per-call copy in the transcript would duplicate it on every
 * update. What the widget cannot show is *which* item a given call started
 * working on, so that one item is carried as a body section — expand-only in
 * the TUI, and the line a status tracker leads with.
 */
export function todoView({ args }: TodoViewInput): ToolView {
  const todos = ((args ?? {}) as Partial<TodoInput>).todos;
  // Args stream in partially and a weak model may send junk, so the view only
  // trusts the shape once it is actually there.
  const items = Array.isArray(todos) ? todos : [];
  return {
    label: "Todo",
    icon: "checklist",
    title: [{ kind: "text", text: formatStatusSummary(items) }],
    body: inProgressSection(items),
  };
}

/**
 * The last in-progress item, since a model that marks several picks up the
 * bottom one; nothing when the call only completes or reorders.
 */
function inProgressSection(items: readonly TodoItem[]): readonly ViewBlock[] {
  const current = items.findLast(
    (item) => (item as Partial<TodoItem> | null)?.status === "in_progress"
  );
  const content =
    typeof current?.content === "string"
      ? current.content.trim().replaceAll(/\s+/gu, " ")
      : "";
  if (content === "") {
    return [];
  }
  return [
    {
      kind: "section",
      label: "In progress",
      icon: "checklist",
      content: [{ kind: "spans", spans: [{ text: content, strong: true }] }],
    },
  ];
}

export function formatWidgetTitle(
  items: readonly TodoItem[],
  theme: Theme
): string {
  const noun = items.length === 1 ? "todo" : "todos";
  const total = theme.bold(`${items.length} ${noun}`);
  const summary = formatStatusSummary(items);
  return summary ? `${total} (${summary})` : total;
}

export function renderWidgetLines(
  items: readonly TodoItem[],
  theme: Theme
): string[] {
  if (items.length === 0) {
    return [];
  }

  const visibleItems = selectVisibleWidgetItems(items);
  const hidden = items.length - visibleItems.length;

  return [
    formatWidgetTitle(items, theme),
    ...visibleItems.map((item) => styleItem(item, theme)),
    ...(hidden > 0 ? [theme.fg("muted", `… +${hidden} more`)] : []),
  ];
}

function selectVisibleWidgetItems(
  items: readonly TodoItem[]
): readonly TodoItem[] {
  if (items.length <= MAX_UNTRUNCATED_WIDGET_TODOS) {
    return items;
  }

  const anchorIndex = findWidgetAnchorIndex(items);
  const start = clamp(
    anchorIndex - WIDGET_ANCHOR_SLOT,
    0,
    items.length - MAX_TRUNCATED_WIDGET_TODOS
  );

  return items.slice(start, start + MAX_TRUNCATED_WIDGET_TODOS);
}

function findWidgetAnchorIndex(items: readonly TodoItem[]): number {
  const inProgress = items.findIndex((item) => item.status === "in_progress");
  if (inProgress >= 0) {
    return inProgress;
  }

  const lastNonPending = items.findLastIndex(
    (item) => item.status !== "pending"
  );
  return lastNonPending >= 0 ? lastNonPending : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatStatusSummary(items: readonly TodoItem[]): string {
  let pending = 0;
  let done = 0;
  let cancelled = 0;
  for (const item of items) {
    switch (item.status) {
      case "pending":
      case "in_progress":
        pending += 1;
        break;
      case "completed":
        done += 1;
        break;
      case "cancelled":
        cancelled += 1;
        break;
    }
  }

  const segments: string[] = [];
  if (done > 0) {
    segments.push(`${done} done`);
  }
  if (pending > 0) {
    segments.push(`${pending} pending`);
  }
  if (cancelled > 0) {
    segments.push(`${cancelled} cancelled`);
  }
  if (segments.length === 0) {
    return "cleared";
  }
  return segments.join(", ");
}

function styleItem(item: TodoItem, theme: Theme): string {
  switch (item.status) {
    case "pending":
      return `□ ${item.content}`;
    case "in_progress":
      return `${theme.fg("warning", "➤")} ${theme.bold(item.content)}`;
    case "completed":
      return `${theme.fg("success", "✔")} ${theme.fg("muted", item.content)}`;
    case "cancelled":
      return `${theme.fg("muted", "✘")} ${theme.fg("muted", theme.strikethrough(item.content))}`;
  }
}
