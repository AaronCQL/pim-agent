import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { STATUSES, type TodoItem, type TodoStatus } from "./schema";

export const TODO_STATE_CUSTOM_TYPE = "pim-todo-state";

export type TodoSummary = Record<TodoStatus, number>;

export type TodoDetails = {
  readonly todos: readonly TodoItem[];
  readonly summary: TodoSummary;
};

export type FormatChecklistOptions = {
  readonly activeOnly?: boolean;
};

export type TodoSessionKey = ExtensionContext["sessionManager"];

const itemsBySession = new WeakMap<TodoSessionKey, TodoItem[]>();

const markers: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[>]",
  completed: "[x]",
  cancelled: "[~]",
};

const statusSet: ReadonlySet<TodoStatus> = new Set(STATUSES);

export function getCurrentItems(
  sessionManager: TodoSessionKey
): readonly TodoItem[] {
  return itemsBySession.get(sessionManager) ?? [];
}

export function replaceItems(
  sessionManager: TodoSessionKey,
  items: readonly TodoItem[]
): readonly TodoItem[] {
  const normalized = normalizeItems(items);
  itemsBySession.set(sessionManager, normalized);
  return normalized;
}

export function resetItems(sessionManager: TodoSessionKey): void {
  itemsBySession.set(sessionManager, []);
}

export function reconstructFromBranch(
  sessionManager: TodoSessionKey,
  branch: readonly unknown[]
): readonly TodoItem[] {
  const items = findLatestTodoItems(branch);
  itemsBySession.set(sessionManager, items);
  return items;
}

export function normalizeItems(items: readonly TodoItem[]): TodoItem[] {
  return items.flatMap((item) => {
    const content = normalizeContent(item.content);
    return content ? [{ content, status: item.status }] : [];
  });
}

export function hasActiveItems(items: readonly TodoItem[]): boolean {
  return items.some(isActive);
}

function summarizeItems(items: readonly TodoItem[]): TodoSummary {
  const summary: TodoSummary = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    cancelled: 0,
  };
  for (const item of items) {
    summary[item.status] += 1;
  }
  return summary;
}

export function makeDetails(items: readonly TodoItem[]): TodoDetails {
  return {
    todos: structuredClone(items),
    summary: summarizeItems(items),
  };
}

export function formatUpdateSummary(items: readonly TodoItem[]): string {
  const summary = summarizeItems(items);
  const segments = [
    summary.completed > 0 ? `${summary.completed} completed` : undefined,
    summary.in_progress > 0 ? `${summary.in_progress} in progress` : undefined,
    summary.pending > 0 ? `${summary.pending} pending` : undefined,
    summary.cancelled > 0 ? `${summary.cancelled} cancelled` : undefined,
  ].filter((segment) => segment !== undefined);
  return segments.length === 0
    ? "Todos cleared."
    : `Todos updated: ${segments.join(", ")}.`;
}

export function formatChecklist(
  items: readonly TodoItem[],
  options: FormatChecklistOptions = {}
): string {
  return items
    .filter((item) => !options.activeOnly || isActive(item))
    .map((item) => `${markers[item.status]} ${item.content}`)
    .join("\n");
}

function isActive(item: TodoItem): boolean {
  return item.status === "pending" || item.status === "in_progress";
}

export function normalizeContent(content: string): string {
  return content.trim().replaceAll(/\s+/g, " ");
}

function findLatestTodoItems(branch: readonly unknown[]): TodoItem[] {
  for (let i = branch.length - 1; i >= 0; i--) {
    const items = extractTodoItems(branch[i]);
    if (items) {
      return items;
    }
  }
  return [];
}

function extractTodoItems(entry: unknown): TodoItem[] | undefined {
  const holder = todoHolder(entry);
  return isRecord(holder) && Array.isArray(holder.todos)
    ? normalizeUnknownItems(holder.todos)
    : undefined;
}

/** The todo tool result's details, or a compaction checkpoint's data. */
function todoHolder(entry: unknown): unknown {
  if (!isRecord(entry)) {
    return undefined;
  }
  if (entry.type === "custom" && entry.customType === TODO_STATE_CUSTOM_TYPE) {
    return entry.data;
  }
  const message = entry.type === "message" ? entry.message : undefined;
  return isRecord(message) &&
    message.role === "toolResult" &&
    message.toolName === "todo"
    ? message.details
    : undefined;
}

function normalizeUnknownItems(items: readonly unknown[]): TodoItem[] {
  const out: TodoItem[] = [];
  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    const { content, status } = item;
    if (typeof content !== "string" || !isStatus(status)) {
      continue;
    }
    const normalizedContent = normalizeContent(content);
    if (!normalizedContent) {
      continue;
    }
    out.push({ content: normalizedContent, status });
  }
  return out;
}

function isStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && statusSet.has(value as TodoStatus);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
