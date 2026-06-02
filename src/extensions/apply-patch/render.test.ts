import { describe, expect, test } from "bun:test";
import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { DiffLines, type ToolDiff } from "../../shared/DiffLines";
import type { DiffRenderState } from "../../shared/DiffView";
import type { ApplyEntry } from "./executor";
import { renderApplyPatchCall, renderApplyPatchResult } from "./render";

const stubTheme = {
  name: "test",
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

const styledTheme = {
  name: "styled-test",
  fg: (color: string, text: string) =>
    color === "dim" ? `<dim>${text}</dim>` : text,
  bold: (text: string) => text,
  strikethrough: (text: string) => `<s>${text}</s>`,
} as unknown as Theme;

const ctx = (state: DiffRenderState) => ({
  cwd: "/repo",
  isPartial: false,
  isError: false,
  lastComponent: undefined,
  state,
});

// A title component left in `state` by the call, for the result to reuse.
const calledState = (): DiffRenderState => ({
  titleComponent: { render: () => [], invalidate() {} },
  path: "a",
});

const changeDiff = (path: string): ToolDiff =>
  DiffLines.buildToolDiff(
    path,
    { lines: ["alpha", "beta"], hasTrailingNewline: true },
    { lines: ["alpha", "BETA"], hasTrailingNewline: true },
    3
  )!;

const addDiff = (path: string): ToolDiff =>
  DiffLines.buildToolDiff(
    path,
    { lines: [], hasTrailingNewline: false },
    { lines: ["one", "two"], hasTrailingNewline: true },
    3
  )!;

const removeDiff = (path: string): ToolDiff =>
  DiffLines.buildToolDiff(
    path,
    { lines: ["x", "y", "z"], hasTrailingNewline: true },
    { lines: [], hasTrailingNewline: false },
    3
  )!;

const resultWith = (entries: readonly ApplyEntry[]): AgentToolResult<unknown> =>
  ({
    content: [{ type: "text", text: "ok" }],
    details: { entries },
  }) as unknown as AgentToolResult<unknown>;

const renderText = (
  entries: readonly ApplyEntry[],
  state: DiffRenderState = {},
  theme: Theme = stubTheme
): string =>
  (
    renderApplyPatchResult(
      resultWith(entries),
      { expanded: false, isPartial: false },
      theme,
      ctx(state)
    ) as Container
  )
    .render(240)
    .join("\n");

describe("renderApplyPatchCall", () => {
  test("draws a title up front and stores it in state for reuse", () => {
    const state: DiffRenderState = {};
    const comp = renderApplyPatchCall(
      {
        input:
          "*** Begin Patch\n*** Update File: a.txt\n@@\n-x\n+y\n*** End Patch",
      },
      stubTheme,
      ctx(state)
    );
    expect(comp).toBeDefined();
    expect(state.titleComponent).toBeDefined();
  });
});

describe("renderApplyPatchResult", () => {
  test("update reuses the call title; container holds just the diff body", () => {
    const out = renderApplyPatchResult(
      resultWith([
        {
          action: { kind: "update", path: "/repo/a.txt" },
          diff: changeDiff("/repo/a.txt"),
        },
      ]),
      { expanded: false, isPartial: false },
      stubTheme,
      ctx(calledState())
    );
    expect((out as Container).children).toHaveLength(1);
  });

  test("add renders a Write label with green content", () => {
    const text = renderText([
      {
        action: { kind: "add", path: "/repo/new.ts" },
        diff: addDiff("/repo/new.ts"),
      },
    ]);
    expect(text).toContain("Write");
    expect(text).toContain("new.ts");
    expect(text).toContain("+2"); // added-line stat in the title
    expect(text).toContain("one"); // green content body
    expect(text).toContain("two");
  });

  test("delete renders a Delete label, title only with a -N stat", () => {
    const text = renderText([
      {
        action: { kind: "delete", path: "/repo/old.ts" },
        diff: removeDiff("/repo/old.ts"),
      },
    ]);
    expect(text).toContain("Delete");
    expect(text).toContain("-3");
    // No removed-content body.
    expect(text).not.toContain("-x");
  });

  test("pure rename renders Move with a compact arrow title and no body", () => {
    const text = renderText([
      {
        action: {
          kind: "move",
          path: "/repo/.pim-edit-tool-test/beta.txt",
          movePath: "/repo/.pim-edit-tool-test/gamma.txt",
        },
        diff: undefined,
      },
    ]);
    expect(text).toContain("Move");
    expect(text).toContain(".pim-edit-tool-test/{beta.txt ➝ gamma.txt}");
    expect(text).not.toContain("Edit");
  });

  test("pure rename dims structure and strikes the old changed segment", () => {
    const text = renderText(
      [
        {
          action: {
            kind: "move",
            path: "/repo/aaa/bbb/test.txt",
            movePath: "/repo/aaa/ccc/test.txt",
          },
          diff: undefined,
        },
      ],
      {},
      styledTheme
    );
    expect(text).toContain(
      "aaa/<dim>{</dim><dim><s>bbb</s></dim><dim> ➝ </dim>ccc<dim>}</dim>/test.txt"
    );
  });

  test("move + edit renders Edit with the compact arrow title and a diff", () => {
    const text = renderText([
      {
        action: { kind: "move", path: "/repo/a.ts", movePath: "/repo/b.ts" },
        diff: changeDiff("/repo/b.ts"),
      },
    ]);
    expect(text).toContain("Edit");
    expect(text).toContain("{a.ts ➝ b.ts}");
    expect(text).toContain("BETA");
  });

  test("multi-file appends further files with a padding row between", () => {
    const out = renderApplyPatchResult(
      resultWith([
        {
          action: { kind: "update", path: "/repo/a.txt" },
          diff: changeDiff("/repo/a.txt"),
        },
        {
          action: { kind: "update", path: "/repo/b.txt" },
          diff: changeDiff("/repo/b.txt"),
        },
      ]),
      { expanded: false, isPartial: false },
      stubTheme,
      ctx(calledState())
    );
    // body(file1) + blank + title(file2) + body(file2)
    expect((out as Container).children).toHaveLength(4);
  });
});
