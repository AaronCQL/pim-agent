import { describe, expect, test } from "bun:test";
import type {
  AgentToolResult,
  ExtensionAPI,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import registerGrep from "./index";

const stubTheme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

function registeredTool(): ToolDefinition {
  let tool: ToolDefinition | undefined;
  registerGrep({
    registerTool(def: ToolDefinition): void {
      tool = def;
    },
  } as unknown as ExtensionAPI);

  if (tool === undefined) {
    throw new Error("grep tool was not registered");
  }
  return tool;
}

/**
 * Mimics pi's redraw loop: `renderResult` stashes the settled result and
 * schedules an `invalidate()`, after which pi re-runs `renderCall` with the
 * same state and the previously returned component. The redraw is deferred to
 * a microtask, so a test that wants the updated title has to `await flush()`.
 */
function harness(args: Record<string, unknown>) {
  const tool = registeredTool();
  const state = {};
  let title: Component | undefined;
  const context = {
    args,
    toolCallId: "grep-1",
    invalidate: () => {
      title = tool.renderCall!(args, stubTheme, {
        ...context,
        lastComponent: title,
      });
    },
    lastComponent: undefined as Component | undefined,
    state,
    cwd: "/repo",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: true,
    isError: false,
  };

  return {
    renderCall: () => {
      title = tool.renderCall!(args, stubTheme, context);
      return title;
    },
    renderResult: (result: AgentToolResult<unknown>, expanded = false) =>
      tool.renderResult!(result, { expanded, isPartial: false }, stubTheme, {
        ...context,
        lastComponent: undefined,
      }),
    flush: () => Promise.resolve(),
  };
}

describe("grep tool renderer", () => {
  test("updates the visible call title with the file count when the result renders", async () => {
    const { renderCall, renderResult, flush } = harness({ pattern: "alpha" });
    const callComponent = renderCall();

    expect(callComponent.render(120).join("\n")).toContain("Grep: /alpha/");
    expect(callComponent.render(120).join("\n")).not.toContain("2 files");

    renderResult({
      content: [{ type: "text", text: "src/a.ts\nsrc/b.ts" }],
      details: { fileCount: 2, outputMode: "files_with_matches" },
    });
    await flush();

    expect(callComponent.render(120).join("\n")).toContain("2 files");
  });

  test("renders the result body verbatim for every output mode", () => {
    const bodies = {
      files_with_matches: "src/a.ts\nsrc/b.ts",
      content: "> src/a.ts:1:alpha\n--\n  src/a.ts:9:tail",
      count: "src/a.ts:2\nsrc/b.ts:1",
    } as const;

    for (const [outputMode, text] of Object.entries(bodies)) {
      const { renderCall, renderResult } = harness({ pattern: "alpha" });
      renderCall();
      const body = renderResult(
        { content: [{ type: "text", text }], details: { outputMode } },
        true
      );

      expect(
        body
          .render(120)
          .map((line) => line.slice(" │ ".length).trimEnd())
          .join("\n")
      ).toBe(text);
    }
  });
});
