import { describe, expect, test } from "bun:test";
import type { TodoItem } from "./schema";
import {
  formatChecklist,
  formatUpdateSummary,
  getCurrentItems,
  normalizeItems,
  reconstructFromBranch,
  replaceItems,
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
  test.each([
    [
      allStatuses,
      "Todos updated: 1 completed, 1 in progress, 1 pending, 1 cancelled.",
    ],
    [[{ content: "next", status: "pending" }], "Todos updated: 1 pending."],
    [[], "Todos cleared."],
  ] as const)("update summary %#", (items, expected) => {
    expect(formatUpdateSummary(items)).toBe(expected);
  });

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

  test("content is normalized to a single trimmed line and blank content is dropped", () => {
    expect(
      normalizeItems([
        { content: "", status: "pending" },
        { content: "   ", status: "in_progress" },
        { content: "  keep\nthis\titem  ", status: "completed" },
      ])
    ).toEqual([{ content: "keep this item", status: "completed" }]);
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

  test("reconstruction prefers a later checkpoint over an older tool result", () => {
    const branch = [
      toolResult("todo", [{ content: "old", status: "pending" }]),
      todoStateEntry([{ content: "checkpointed", status: "in_progress" }]),
    ];

    expect(reconstructFromBranch(fakeSession(), branch)).toEqual([
      { content: "checkpointed", status: "in_progress" },
    ]);
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
