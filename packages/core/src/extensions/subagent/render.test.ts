import { describe, expect, test } from "bun:test";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { ToolViewInput } from "../../shared/Tools";
import { AnsiPainter } from "../../view/AnsiPainter";
import type { subagentSchema } from "./schema";
import type { SubagentDetails, SubagentEntry } from "./subagent";
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
  entries: [
    { kind: "tool", callId: "c1", name: "read", isError: false },
    { kind: "text", text: "body" },
  ],
  activeToolNames: [],
  lastToolName: "read",
  stopReason: "stop",
  errorMessage: undefined,
  model: "deepseek-v4-flash",
  contextWindow: 1_000_000,
};

function detailsWith(overrides: Partial<SubagentDetails>): SubagentDetails {
  return { ...baseDetails, ...overrides };
}

function toolEntries(
  names: readonly string[],
  failed: readonly string[] = []
): readonly SubagentEntry[] {
  return names.map((name, index) => ({
    kind: "tool",
    callId: `c${index}`,
    name,
    isError: failed.includes(`c${index}`),
  }));
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

  test("top line is the summary flattened: roster, turns, cost", () => {
    expect(formatTopLine(baseDetails)).toBe("read ⬝ 3 turns ⬝ $0.23");
  });

  test("top line names what the child is doing while it still runs", () => {
    const running = detailsWith({
      stopReason: undefined,
      activeToolNames: ["grep"],
    });

    expect(formatTopLine(running)).toBe("read ⬝ 3 turns ⬝ $0.23 ⬝ grep…");
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

  test("summarizes what the run did, muted, with muted dots", () => {
    const details = detailsWith({
      entries: toolEntries(["read", "grep", "read", "read"]),
    });
    const view = subagentView(viewInput({ details }));

    expect(AnsiPainter.paint(view.summary ?? [], stubTheme)).toEqual([
      "<muted>read ×3</muted><muted> ⬝ </muted><muted>grep</muted>" +
        "<muted> ⬝ </muted><muted>3 turns</muted>" +
        "<muted> ⬝ </muted><muted>$0.23</muted>",
    ]);
  });

  test("marks a tool that failed without recolouring the rest", () => {
    const details = detailsWith({
      entries: toolEntries(["bash", "bash"], ["c1"]),
    });
    const view = subagentView(viewInput({ details }));

    expect(AnsiPainter.paint(view.summary ?? [], stubTheme)[0]).toContain(
      "<muted>bash ×2</muted><error> (1 failed)</error>"
    );
  });

  test("elides the roster past eight distinct tools", () => {
    const names = Array.from({ length: 11 }, (_, index) => `t${index}`);
    const view = subagentView(
      viewInput({ details: detailsWith({ entries: toolEntries(names) }) })
    );
    const painted = AnsiPainter.paint(view.summary ?? [], stubTheme)[0] ?? "";

    expect(painted).toContain("<muted>t7</muted>");
    expect(painted).not.toContain("<muted>t8</muted>");
    expect(painted).toContain("<muted>… 3 more</muted>");
  });

  test("keeps the summary free of the context window and the model", () => {
    const painted =
      AnsiPainter.paint(
        subagentView(viewInput({ details: baseDetails })).summary ?? [],
        stubTheme
      )[0] ?? "";

    expect(painted).not.toContain("deepseek-v4-flash");
    expect(painted).not.toContain("1.0M");
  });

  test("warns on the summary while the run is still streaming", () => {
    const view = subagentView(
      viewInput({ details: baseDetails, isPartial: true })
    );

    expect(AnsiPainter.paint(view.summary ?? [], stubTheme)[0]).toContain(
      "<warning>read</warning>"
    );
  });

  test("has no summary before any details land", () => {
    expect(subagentView(viewInput({ settled: false })).summary).toEqual([]);
  });

  test("replays a session recorded before the roster existed", () => {
    const legacy = {
      ...baseDetails,
      entries: undefined,
    } as unknown as SubagentDetails;
    const view = subagentView(viewInput({ details: legacy }));

    expect(AnsiPainter.paint(view.summary ?? [], stubTheme)).toEqual([
      "<muted>3 turns</muted><muted> ⬝ </muted><muted>$0.23</muted>",
    ]);
    expect(view.body?.[0]).toEqual({ kind: "markdown", text: "body" });
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

  test("streams the partial body while the call is still running", () => {
    const partial = detailsWith({
      fullOutput: "Reading the confi",
      returnedOutput: "Reading the confi",
      stopReason: undefined,
      activeToolNames: ["read"],
    });
    const view = subagentView(
      viewInput({
        text: formatTopLine(partial),
        details: partial,
        isPartial: true,
      })
    );

    expect(view.body?.[0]).toEqual({
      kind: "markdown",
      text: "Reading the confi",
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

  test("foots the body with the context window and the model", () => {
    const view = subagentView(viewInput({ details: baseDetails }));

    expect(view.body?.at(-1)).toEqual({
      kind: "kv",
      pairs: [
        ["context", "0.4% of 1.0M"],
        ["model", "deepseek-v4-flash"],
      ],
    });
  });

  test("omits a context the child never reported", () => {
    const view = subagentView(
      viewInput({
        details: detailsWith({
          usage: { ...baseDetails.usage, contextTokens: undefined },
        }),
      })
    );

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
