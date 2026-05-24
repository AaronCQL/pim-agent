import { describe, expect, test } from "bun:test";
import type {
  AgentToolResult,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { SubagentDetails } from "./subagent";
import {
  formatCallTitle,
  formatTopLine,
  renderCall,
  renderResult,
} from "./render";

const stubTheme = {
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
  underline: (text: string) => text,
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

type ColorCall = {
  readonly color: ThemeColor;
  readonly text: string;
};

function tracingTheme(): {
  readonly theme: Theme;
  readonly calls: ColorCall[];
} {
  const calls: ColorCall[] = [];
  return {
    calls,
    theme: {
      bold: (text: string) => text,
      italic: (text: string) => text,
      strikethrough: (text: string) => text,
      underline: (text: string) => text,
      fg: (color: ThemeColor, text: string) => {
        calls.push({ color, text });
        return text;
      },
    } as unknown as Theme,
  };
}

const baseDetails: SubagentDetails = {
  returnedOutput: "body",
  fullOutput: "body",
  outputTruncated: false,
  omittedBytes: 0,
  usage: {
    input: 10,
    output: 5,
    cacheRead: 2,
    cacheWrite: 0,
    cost: 0.23,
    turns: 3,
    contextTokens: 4000,
  },
  toolCalls: [{ name: "read", isError: false }],
  activeToolNames: [],
  lastToolName: "read",
  stopReason: "stop",
  errorMessage: undefined,
  model: "deepseek-v4-flash",
  contextWindow: 1_000_000,
  topLine: "$0.23 ⬝ 0.4%/1.0M ⬝ deepseek-v4-flash ⬝ 3 turns ⬝ 1 tool",
};

function result(text: string): AgentToolResult<SubagentDetails> {
  return { content: [{ type: "text", text }], details: baseDetails };
}

describe("subagent render formatting", () => {
  test("call title uses the first line without truncating", () => {
    const long = `${"x".repeat(140)}\nsecond`;

    expect(formatCallTitle(long)).toBe("x".repeat(140));
  });

  test("top line includes cost, context, model, and activity", () => {
    expect(formatTopLine(baseDetails)).toBe(
      "$0.23 ⬝ 0.4%/1.0M ⬝ deepseek-v4-flash ⬝ 3 turns ⬝ 1 tool"
    );
  });

  test("call title renders prompt markdown", () => {
    const component = renderCall(
      { prompt: "Review **bold** and `code`" },
      stubTheme,
      {
        lastComponent: undefined,
        isPartial: false,
        isError: false,
      }
    );

    expect(component.render(80)[0]?.trimEnd()).toBe(
      " ▪ Subagent: Review bold and code"
    );
  });

  test("call title uses the default color for prompt text", () => {
    const rendered = tracingTheme();
    renderCall({ prompt: "plain prompt" }, rendered.theme, {
      lastComponent: undefined,
      isPartial: false,
      isError: false,
    }).render(80);

    expect(rendered.calls).not.toContainEqual({
      color: "toolTitle",
      text: "plain prompt",
    });
  });

  test("call title colors the Subagent label by running status", () => {
    const pending = tracingTheme();
    renderCall({ prompt: "investigate" }, pending.theme, {
      lastComponent: undefined,
      isPartial: true,
      isError: false,
    }).render(80);

    expect(pending.calls).toContainEqual({
      color: "warning",
      text: "Subagent",
    });

    const done = tracingTheme();
    renderCall({ prompt: "investigate" }, done.theme, {
      lastComponent: undefined,
      isPartial: false,
      isError: false,
    }).render(80);

    expect(done.calls).toContainEqual({ color: "accent", text: "Subagent" });
  });

  test("top line uses muted dots with accent or warning content", () => {
    const done = tracingTheme();
    renderResult(
      result("body"),
      { expanded: false, isPartial: false },
      done.theme,
      { lastComponent: undefined, isPartial: false, isError: false }
    ).render(80);

    expect(done.calls).toContainEqual({ color: "accent", text: "$0.23 " });
    expect(done.calls).toContainEqual({ color: "muted", text: "⬝" });

    const running = tracingTheme();
    renderResult(
      {
        content: [{ type: "text", text: "ignored body" }],
        details: { ...baseDetails, stopReason: undefined },
      },
      { expanded: false, isPartial: true },
      running.theme,
      { lastComponent: undefined, isPartial: true, isError: false }
    ).render(80);

    expect(running.calls).toContainEqual({ color: "warning", text: "$0.23 " });
    expect(running.calls).toContainEqual({ color: "muted", text: "⬝" });
  });

  test("partial render displays only the running top line", () => {
    const runningDetails: SubagentDetails = {
      ...baseDetails,
      toolCalls: [],
      activeToolNames: ["grep"],
      stopReason: undefined,
      topLine: "$0.23 ⬝ 0.4%/1.0M ⬝ deepseek-v4-flash ⬝ 3 turns ⬝ grep",
    };
    const component = renderResult(
      {
        content: [{ type: "text", text: "ignored body" }],
        details: runningDetails,
      },
      { expanded: false, isPartial: true },
      stubTheme,
      { lastComponent: undefined, isPartial: true, isError: false }
    );

    expect(component.render(80)).toEqual([` │ ${runningDetails.topLine}`]);
  });

  test("collapsed done render hides the final message", () => {
    const body = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join(
      "\n"
    );
    const component = renderResult(
      result(body),
      { expanded: false, isPartial: false },
      stubTheme,
      { lastComponent: undefined, isPartial: false, isError: false }
    );

    expect(component.render(80)).toEqual([` │ ${baseDetails.topLine}`]);
  });

  test("expanded done render keeps the top line above the final message", () => {
    const component = renderResult(
      result("line 1\nline 2"),
      { expanded: true, isPartial: false },
      stubTheme,
      { lastComponent: undefined, isPartial: false, isError: false }
    );

    expect(component.render(80)).toEqual([
      ` │ ${baseDetails.topLine}`,
      " │ line 1",
      " │ line 2",
    ]);
  });

  test("expanded done render renders final message markdown", () => {
    const component = renderResult(
      result("Final **answer** and `code`"),
      { expanded: true, isPartial: false },
      stubTheme,
      { lastComponent: undefined, isPartial: false, isError: false }
    );

    expect(component.render(80)).toEqual([
      ` │ ${baseDetails.topLine}`,
      " │ Final answer and code",
    ]);
  });

  test("expanded done render uses the default color for final message text", () => {
    const rendered = tracingTheme();
    renderResult(
      result("plain final"),
      { expanded: true, isPartial: false },
      rendered.theme,
      { lastComponent: undefined, isPartial: false, isError: false }
    ).render(80);

    expect(rendered.calls).not.toContainEqual({
      color: "toolOutput",
      text: "plain final",
    });
  });
});
