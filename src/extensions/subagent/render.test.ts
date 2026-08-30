import { describe, expect, test } from "bun:test";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { ToolViewInput } from "../../shared/Tools";
import { AnsiPainter } from "../../shared/view/AnsiPainter";
import type { subagentSchema } from "./schema";
import type { SubagentDetails } from "./subagent";
import { formatCallTitle, formatTopLine, subagentView } from "./render";

type SubagentViewInput = ToolViewInput<typeof subagentSchema, SubagentDetails>;

const stubTheme = {
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
  underline: (text: string) => text,
  fg: (color: ThemeColor, text: string) => `<${color}>${text}</${color}>`,
} as unknown as Theme;

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

function viewInput(args: {
  readonly prompt?: string;
  readonly text?: string;
  readonly details?: SubagentDetails;
  readonly isPartial?: boolean;
  readonly settled?: boolean;
}): SubagentViewInput {
  const settled = args.settled ?? true;
  return {
    args: { prompt: args.prompt ?? "investigate" },
    ...(settled
      ? {
          result: {
            content: [{ type: "text", text: args.text ?? "body" }],
            details: args.details as SubagentDetails,
          },
        }
      : {}),
    isPartial: args.isPartial ?? false,
    cwd: "/repo",
  };
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
});

describe("subagentView", () => {
  test("titles the row with the prompt as markdown", () => {
    const view = subagentView(
      viewInput({ prompt: "Review **bold** and `code`", details: baseDetails })
    );

    expect(view.label).toBe("Subagent");
    expect(view.title).toEqual([
      { kind: "markdown", text: "Review **bold** and `code`" },
    ]);
  });

  test("colors the label by state", () => {
    expect(subagentView(viewInput({ settled: false })).labelTone).toBe(
      "warning"
    );
    expect(
      subagentView(viewInput({ details: baseDetails, isPartial: true }))
        .labelTone
    ).toBe("warning");
    expect(subagentView(viewInput({ details: baseDetails })).labelTone).toBe(
      "accent"
    );
    expect(subagentView(viewInput({ text: "boom" })).labelTone).toBe("error");
  });

  test("summarizes the top line with muted dots", () => {
    const view = subagentView(viewInput({ details: baseDetails }));

    expect(AnsiPainter.paint(view.summary ?? [], stubTheme)).toEqual([
      "<accent>$0.23 </accent><muted>⬝</muted><accent> 0.4%/1.0M </accent>" +
        "<muted>⬝</muted><accent> deepseek-v4-flash </accent>" +
        "<muted>⬝</muted><accent> 3 turns </accent><muted>⬝</muted>" +
        "<accent> 1 tool</accent>",
    ]);
  });

  test("warns on the summary while the run is still streaming", () => {
    const view = subagentView(
      viewInput({ details: baseDetails, isPartial: true })
    );

    expect(AnsiPainter.paint(view.summary ?? [], stubTheme)[0]).toContain(
      "<warning>$0.23 </warning>"
    );
  });

  test("has no summary before any details land", () => {
    expect(subagentView(viewInput({ settled: false })).summary).toEqual([]);
  });

  test("keeps the final message as an expand-only markdown body", () => {
    const view = subagentView(
      viewInput({ text: "Final **answer**", details: baseDetails })
    );

    expect(view.body).toEqual([{ kind: "markdown", text: "Final **answer**" }]);
    expect(view.collapsed).toBeUndefined();
  });

  test("omits an empty body", () => {
    expect(
      subagentView(viewInput({ text: "", details: baseDetails })).body
    ).toEqual([]);
  });
});
