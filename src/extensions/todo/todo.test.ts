import { describe, expect, test } from "bun:test";
import type { TodoItem } from "./schema";
import {
  formatChecklist,
  getCurrentItems,
  hasActiveItems,
  makeDetails,
  normalizeItems,
  reconstructFromBranch,
  replaceItems,
  summarizeItems,
  type TodoSessionKey,
} from "./todo";

const allStatuses: readonly TodoItem[] = [
  { content: "Plan", status: "pending" },
  { content: "Build", status: "in_progress" },
  { content: "Verify", status: "completed" },
  { content: "Skip obsolete step", status: "cancelled" },
];

function fakeSession(): TodoSessionKey {
  return {} as TodoSessionKey;
}

describe("todo state", () => {
  test("replace semantics keep the latest write only", () => {
    const sm = fakeSession();
    replaceItems(sm, [
      { content: "a", status: "pending" },
      { content: "b", status: "pending" },
      { content: "c", status: "pending" },
    ]);
    const latest = replaceItems(sm, [{ content: "d", status: "in_progress" }]);

    expect(latest).toEqual([{ content: "d", status: "in_progress" }]);
    expect(formatChecklist(getCurrentItems(sm))).toBe("[>] d");
  });

  test("state is isolated between sessions (parent vs subagent)", () => {
    const parent = fakeSession();
    const child = fakeSession();
    replaceItems(parent, [{ content: "parent task", status: "pending" }]);
    replaceItems(child, [{ content: "child task", status: "in_progress" }]);

    expect(getCurrentItems(parent)).toEqual([
      { content: "parent task", status: "pending" },
    ]);
    expect(getCurrentItems(child)).toEqual([
      { content: "child task", status: "in_progress" },
    ]);
  });

  test("content is normalized to a single trimmed line and blank content is dropped", () => {
    expect(
      normalizeItems([
        { content: "", status: "pending" },
        { content: "   ", status: "in_progress" },
        { content: "  keep\nthis\titem  ", status: "completed" },
      ])
    ).toEqual([{ content: "keep this item", status: "completed" }]);
  });

  test("multiple in_progress items are accepted as-is", () => {
    const items = normalizeItems([
      { content: "one", status: "in_progress" },
      { content: "two", status: "in_progress" },
    ]);

    expect(formatChecklist(items)).toBe("[>] one\n[>] two");
  });

  test("duplicate content strings are accepted", () => {
    const items = normalizeItems([
      { content: "repeat", status: "pending" },
      { content: "repeat", status: "completed" },
    ]);

    expect(items).toEqual([
      { content: "repeat", status: "pending" },
      { content: "repeat", status: "completed" },
    ]);
  });

  test("active-only checklist drops completed and cancelled", () => {
    expect(formatChecklist(allStatuses, { activeOnly: true })).toBe(
      "[ ] Plan\n[>] Build"
    );
    expect(
      formatChecklist(
        [
          { content: "done", status: "completed" },
          { content: "skipped", status: "cancelled" },
        ],
        { activeOnly: true }
      )
    ).toBe("");
  });

  test("active item detection treats pending and in-progress as active", () => {
    expect(hasActiveItems(allStatuses)).toBe(true);
    expect(
      hasActiveItems([
        { content: "done", status: "completed" },
        { content: "skipped", status: "cancelled" },
      ])
    ).toBe(false);
  });

  test("full checklist includes all marker styles", () => {
    expect(formatChecklist(allStatuses)).toBe(
      ["[ ] Plan", "[>] Build", "[x] Verify", "[~] Skip obsolete step"].join(
        "\n"
      )
    );
  });

  test("reconstruction finds the most recent todo tool result", () => {
    const branch = [
      toolResult("todo", [{ content: "old", status: "pending" }]),
      toolResult("grep", [{ content: "ignored", status: "completed" }]),
      toolResult("todo", [{ content: "new", status: "in_progress" }]),
    ];

    expect(reconstructFromBranch(fakeSession(), branch)).toEqual([
      { content: "new", status: "in_progress" },
    ]);
  });

  test("reconstruction restores from a pim-todo-state checkpoint after compaction", () => {
    const branch = [
      { type: "compaction", summary: "old todos summarized away" },
      todoStateEntry([{ content: "kept", status: "in_progress" }]),
    ];

    expect(reconstructFromBranch(fakeSession(), branch)).toEqual([
      { content: "kept", status: "in_progress" },
    ]);
  });

  test("reconstruction prefers a later tool result over an older checkpoint", () => {
    const branch = [
      todoStateEntry([{ content: "old", status: "pending" }]),
      toolResult("todo", [{ content: "new", status: "completed" }]),
    ];

    expect(reconstructFromBranch(fakeSession(), branch)).toEqual([
      { content: "new", status: "completed" },
    ]);
  });

  test("reconstruction prefers a later checkpoint over an older tool result", () => {
    const branch = [
      toolResult("todo", [{ content: "old", status: "pending" }]),
      todoStateEntry([{ content: "checkpointed", status: "in_progress" }]),
    ];

    expect(reconstructFromBranch(fakeSession(), branch)).toEqual([
      { content: "checkpointed", status: "in_progress" },
    ]);
  });

  test("summary counts statuses", () => {
    expect(summarizeItems(allStatuses)).toEqual({
      pending: 1,
      in_progress: 1,
      completed: 1,
      cancelled: 1,
    });
    expect(makeDetails(allStatuses).summary).toEqual({
      pending: 1,
      in_progress: 1,
      completed: 1,
      cancelled: 1,
    });
  });
});

function toolResult(toolName: string, todos: readonly TodoItem[]): unknown {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolName,
      details: { todos },
    },
  };
}

function todoStateEntry(todos: readonly TodoItem[]): unknown {
  return {
    type: "custom",
    customType: "pim-todo-state",
    data: { todos },
  };
}
