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

describe("glob tool renderer", () => {
  test("updates the visible call title with the file count when the result renders", () => {
    const tool = registeredTool();
    const args = { pattern: "**/*.ts" };
    const state = {};
    const callContext = {
      args,
      toolCallId: "glob-1",
      invalidate: () => {},
      lastComponent: undefined,
      state,
      cwd: "/repo",
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: false,
      showImages: true,
      isError: false,
    };
    const callComponent = tool.renderCall!(args, stubTheme, callContext);

    expect(callComponent.render(120).join("\n")).not.toContain("(2 files)");

    const result: AgentToolResult<unknown> = {
      content: [{ type: "text", text: "src/a.ts\nsrc/b.ts" }],
      details: { fileCount: 2 },
    };
    tool.renderResult!(
      result,
      { expanded: false, isPartial: false },
      stubTheme,
      {
        ...callContext,
        lastComponent: undefined,
      }
    );

    expect(callComponent.render(120).join("\n")).toContain("(2 files)");
  });
});
