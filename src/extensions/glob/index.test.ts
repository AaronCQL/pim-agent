import { describe, expect, test } from "bun:test";
import type {
  AgentToolResult,
  ExtensionAPI,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import registerGlob from "./index";

const stubTheme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

function registeredTool(): ToolDefinition {
  let tool: ToolDefinition | undefined;
  registerGlob({
    registerTool(def: ToolDefinition): void {
      tool = def;
    },
  } as unknown as ExtensionAPI);

  if (tool === undefined) {
    throw new Error("glob tool was not registered");
  }
  return tool;
}

const args = { pattern: "**/*.ts" };

const result: AgentToolResult<unknown> = {
  content: [{ type: "text", text: "src/a.ts\nsrc/b.ts" }],
  details: { fileCount: 2 },
};

function context(overrides: Record<string, unknown> = {}) {
  return {
    args,
    toolCallId: "glob-1",
    invalidate: () => {},
    lastComponent: undefined,
    state: {},
    cwd: "/repo",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: true,
    isError: false,
    ...overrides,
  } as unknown as Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];
}

describe("glob tool renderer", () => {
  test("renders the call title from args alone while in flight", () => {
    const lines = registeredTool().renderCall!(
      args,
      stubTheme,
      context()
    ).render(120);
    expect(lines[0]?.trimEnd()).toBe(" ▪ Glob: **/*.ts");
  });

  test("adds the file count to the title once the result settles", () => {
    const tool = registeredTool();
    const ctx = context();
    tool.renderResult!(
      result,
      { expanded: false, isPartial: false },
      stubTheme,
      ctx
    );

    const lines = tool.renderCall!(args, stubTheme, ctx).render(120);
    expect(lines[0]?.trimEnd()).toBe(" ▪ Glob: **/*.ts (2 files)");
  });

  test("renders matched paths in the expanded body", () => {
    const component = registeredTool().renderResult!(
      result,
      { expanded: true, isPartial: false },
      stubTheme,
      context()
    );
    expect(component.render(120)).toEqual([" │ src/a.ts", " │ src/b.ts"]);
  });

  test("shows the raw error text for a failed call", () => {
    const component = registeredTool().renderResult!(
      { content: [{ type: "text", text: "Glob aborted." }], details: {} },
      { expanded: true, isPartial: false },
      stubTheme,
      context({ isError: true })
    );
    expect(component.render(120)).toEqual([" │ Glob aborted."]);
  });
});
