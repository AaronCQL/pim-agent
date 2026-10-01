import { describe, expect, test } from "bun:test";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { ToolViewInput } from "../../shared/Tools";
import { AnsiPainter } from "../../view/AnsiPainter";
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
  sessionId: "0199f0d2-4a7c-7a11-9a3e-1f6c0a5d2b40",
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
  stopReason: "stop",
  errorMessage: undefined,
  model: "deepseek-v4-flash",
  contextWindow: 1_000_000,
};

function detailsWith(overrides: Partial<SubagentDetails>): SubagentDetails {
  return { ...baseDetails, ...overrides };
}

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

  test("top line is the summary flattened: turns, cost, context", () => {
    expect(formatTopLine(baseDetails)).toBe("3 turns ⬝ $0.23 ⬝ 0.4%/1.0M");
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

  test("summarizes what the run cost, muted, with muted dots", () => {
    const view = subagentView(viewInput({ details: baseDetails }));

    expect(AnsiPainter.paint(view.summary ?? [], stubTheme)).toEqual([
      "<muted>3 turns</muted><muted> ⬝ </muted><muted>$0.23</muted>" +
        "<muted> ⬝ </muted><muted>0.4%/1.0M</muted>",
    ]);
  });

  test("summarizes turns and cost alone when no context was reported", () => {
    const view = subagentView(
      viewInput({
        details: detailsWith({
          usage: { ...baseDetails.usage, contextTokens: undefined },
        }),
      })
    );

    expect(AnsiPainter.paint(view.summary ?? [], stubTheme)).toEqual([
      "<muted>3 turns</muted><muted> ⬝ </muted><muted>$0.23</muted>",
    ]);
  });

  test("warns on the summary while the run is still streaming", () => {
    const view = subagentView(
      viewInput({ details: baseDetails, isPartial: true })
    );

    expect(AnsiPainter.paint(view.summary ?? [], stubTheme)[0]).toContain(
      "<warning>3 turns</warning>"
    );
  });

  test("has no summary before any details land", () => {
    expect(subagentView(viewInput({ settled: false })).summary).toEqual([]);
  });

  test("has no summary for a failure pi stripped the details from", () => {
    const stripped = {} as SubagentDetails;

    expect(subagentView(viewInput({ details: stripped })).summary).toEqual([]);
  });

  test("bodies the child's whole narration, not the model-facing content", () => {
    const details = detailsWith({
      fullOutput: "I'll grep first.\n\nFinal **answer**",
      returnedOutput: "Final **answer**",
    });
    const view = subagentView(viewInput({ text: "Final **answer**", details }));

    expect(view.body?.[0]).toEqual({
      kind: "markdown",
      text: "I'll grep first.\n\nFinal **answer**",
    });
  });

  test("keeps a multi-line prompt whole as a body section", () => {
    const view = subagentView(
      viewInput({
        prompt: "Find parseConfig\nand say which are tests",
        details: baseDetails,
      })
    );

    expect(view.body?.[0]).toEqual({
      kind: "section",
      label: "Prompt",
      content: [
        { kind: "text", text: "Find parseConfig\nand say which are tests" },
      ],
    });
  });

  test("leaves a single-line prompt to the title alone", () => {
    const view = subagentView(viewInput({ details: baseDetails }));

    expect(view.body?.some((block) => block.kind === "section")).toBe(false);
  });

  test("foots the body with the model the child ran on", () => {
    const view = subagentView(viewInput({ details: baseDetails }));

    expect(view.body?.at(-1)).toEqual({
      kind: "kv",
      pairs: [["model", "deepseek-v4-flash"]],
    });
  });

  test("falls back to the error text when pi stripped the details", () => {
    expect(subagentView(viewInput({ text: "boom" })).body).toEqual([
      { kind: "markdown", text: "boom" },
    ]);
  });

  test("omits a body with nothing in it", () => {
    expect(subagentView(viewInput({ text: "" })).body).toEqual([]);
  });
});
