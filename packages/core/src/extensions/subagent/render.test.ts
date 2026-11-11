import { describe, expect, test } from "bun:test";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { ToolViewInput } from "../../shared/Tools";
import { AnsiPainter } from "../../view/AnsiPainter";
import type { ViewBlock } from "../../view/ViewBlock";
import type {
  SubagentInput,
  subagentSchema,
  SubagentToolDetails,
} from "./schema";
import type {
  SubagentResultDetails,
  SubagentResultMessage,
} from "./SubagentResult";
import type { SubagentDetails } from "./subagent";
import {
  formatCallTitle,
  formatTopLine,
  subagentResultView,
  subagentView,
} from "./render";

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
    // Old sessions stored no `action`.
    args: { prompt: args.prompt ?? "investigate" } as SubagentInput,
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

const echo = (text: string): ViewBlock => ({
  kind: "markdown",
  text,
  echo: true,
});

describe("subagentView", () => {
  test("a run is labelled Subagent and titled with what it cost, muted, with muted dots", () => {
    const view = subagentView(viewInput({ details: baseDetails }));

    expect(view.label).toBe("Subagent");
    expect(view.summary).toBeUndefined();
    expect(AnsiPainter.paint(view.title, stubTheme)).toEqual([
      "<muted>3 turns</muted><muted> ⬝ </muted><muted>$0.23</muted>" +
        "<muted> ⬝ </muted><muted>0.4%/1.0M</muted>",
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

  test("titles turns and cost alone when no context was reported", () => {
    const view = subagentView(
      viewInput({
        details: detailsWith({
          usage: { ...baseDetails.usage, contextTokens: undefined },
        }),
      })
    );

    expect(AnsiPainter.paint(view.title, stubTheme)).toEqual([
      "<muted>3 turns</muted><muted> ⬝ </muted><muted>$0.23</muted>",
    ]);
  });

  test("warns on the title while the run is still streaming", () => {
    const view = subagentView(
      viewInput({ details: baseDetails, isPartial: true })
    );

    expect(AnsiPainter.paint(view.title, stubTheme)[0]).toContain(
      "<warning>3 turns</warning>"
    );
  });

  test("has an empty title before any details land", () => {
    expect(subagentView(viewInput({ settled: false })).title).toEqual([]);
  });

  test("has an empty title for a failure pi stripped the details from", () => {
    const stripped = {} as SubagentDetails;

    expect(subagentView(viewInput({ details: stripped })).title).toEqual([]);
  });

  test("bodies the prompt, then the child's whole narration, not the model-facing content", () => {
    const details = detailsWith({
      fullOutput: "I'll grep first.\n\nFinal **answer**",
      returnedOutput: "Final **answer**",
    });
    const view = subagentView(viewInput({ text: "Final **answer**", details }));

    expect(view.body?.slice(0, 2)).toEqual([
      echo("investigate"),
      { kind: "markdown", text: "I'll grep first.\n\nFinal **answer**" },
    ]);
  });

  test("keeps a multi-line prompt whole, and shows it before any result", () => {
    const prompt = "Find parseConfig\nand say which are tests";

    expect(
      subagentView(viewInput({ prompt, details: baseDetails })).body?.[0]
    ).toEqual(echo(prompt));
    expect(subagentView(viewInput({ prompt, settled: false })).body).toEqual([
      echo(prompt),
    ]);
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
      echo("investigate"),
      { kind: "markdown", text: "boom" },
    ]);
  });

  test("omits a body with nothing in it", () => {
    expect(subagentView(viewInput({ prompt: " ", text: "" })).body).toEqual([]);
  });
});

describe("subagentView, background jobs", () => {
  const spawnDetails = {
    action: "spawn",
    jobId: "call-1",
    handle: "j1",
    prompt: "Audit the parser\nand its callers",
    owner: { pid: 1, hostname: "h" },
  } as const;

  function call(
    args: Record<string, unknown>,
    details?: SubagentToolDetails,
    text = ""
  ) {
    return subagentView({
      args: args as SubagentInput,
      ...(details === undefined
        ? {}
        : { result: { content: [{ type: "text", text }], details } }),
      isPartial: false,
      cwd: "/repo",
    });
  }

  test("a spawn is titled by its handle, then started, with the prompt in the body", () => {
    const view = call(
      { action: "spawn", prompt: spawnDetails.prompt },
      spawnDetails,
      "Started job j1"
    );

    expect(view.label).toBe("Subagent");
    expect(view.labelTone).toBe("accent");
    expect(view.summary).toBeUndefined();
    expect(AnsiPainter.paint(view.title, stubTheme)).toEqual([
      "j1<muted> ⬝ </muted><muted>started</muted>",
    ]);
    expect(view.body).toEqual([echo(spawnDetails.prompt)]);
  });

  test("a synchronous spawn still renders as the run it awaited", () => {
    const view = call(
      { action: "spawn", prompt: "investigate" },
      baseDetails,
      "body"
    );

    expect(view.label).toBe("Subagent");
    expect(view.body?.[1]).toEqual({ kind: "markdown", text: "body" });
  });

  test("status, stop and steer are titled by the job they name, then their action", () => {
    const status = call(
      { action: "status" },
      { action: "status", jobs: [] },
      "No subagent jobs are running."
    );
    const stop = call(
      { action: "stop", id: "j1", reason: "wrong approach" },
      { action: "stop", jobIds: ["call-1"], reason: "wrong approach" },
      "[stopped]"
    );
    const steer = call(
      { action: "steer", id: "j1", message: "skip docs" },
      { action: "steer", jobId: "call-1", message: "skip docs" },
      "Sent"
    );

    expect(status.label).toBe("Subagent");
    expect(status.title).toEqual([
      { kind: "spans", spans: [{ text: "status" }] },
    ]);
    expect(status.body).toEqual([
      { kind: "text", text: "No subagent jobs are running." },
    ]);
    expect(stop.label).toBe("Subagent");
    expect(AnsiPainter.paint(stop.title, stubTheme)).toEqual([
      "j1<muted> ⬝ </muted>stop<muted> ⬝ </muted><muted>wrong approach</muted>",
    ]);
    expect(steer.label).toBe("Subagent");
    expect(AnsiPainter.paint(steer.title, stubTheme)).toEqual([
      "j1<muted> ⬝ </muted>steer",
    ]);
    expect(steer.body).toEqual([
      { kind: "markdown", text: "skip docs", echo: true },
    ]);
  });

  test("an action still running, or one that failed, keeps its own label and title", () => {
    const view = call({ action: "status", id: "j1" });

    expect(view.labelTone).toBe("warning");
    expect(view.label).toBe("Subagent");
    expect(AnsiPainter.paint(view.title, stubTheme)).toEqual([
      "j1<muted> ⬝ </muted>status",
    ]);
    expect(view.body).toEqual([]);
  });
});

describe("subagentResultView", () => {
  function result(
    details: Partial<SubagentResultDetails>,
    content = "[subagent job j1 done]\nbody"
  ): SubagentResultMessage {
    return {
      customType: "subagent_result",
      content,
      display: true,
      details: {
        ...baseDetails,
        jobId: "call-1",
        handle: "j1",
        prompt: "investigate",
        state: "done",
        ...details,
      },
    };
  }

  test("lays a finished job out as its run, titled by handle and usage", () => {
    const view = subagentResultView(result({}));

    expect(view.label).toBe("Subagent");
    expect(view.labelTone).toBe("accent");
    expect(view.summary).toBeUndefined();
    expect(AnsiPainter.paint(view.title, stubTheme)).toEqual([
      "j1<muted> ⬝ </muted>" +
        "<muted>3 turns</muted><muted> ⬝ </muted><muted>$0.23</muted><muted> ⬝ </muted><muted>0.4%/1.0M</muted>",
    ]);
    expect(view.body?.slice(0, 2)).toEqual([
      echo("investigate"),
      { kind: "markdown", text: "body" },
    ]);
  });

  test("titles the handle alone when a finished run reported no usage", () => {
    const view = subagentResultView(
      result({ usage: undefined } as unknown as Partial<SubagentResultDetails>)
    );

    expect(AnsiPainter.paint(view.title, stubTheme)).toEqual(["j1"]);
  });

  test("tones and explains a job that did not finish", () => {
    const failed = subagentResultView(
      result(
        { state: "failed" },
        "[subagent job j1 failed]\nSubagent failed: error. Error: boom.\nPartial output before failure:\nbody"
      )
    );
    const stopped = subagentResultView(
      result({ state: "stopped", stoppedBy: "agent", reason: "wrong approach" })
    );

    expect(failed.labelTone).toBe("error");
    expect(AnsiPainter.paint(failed.title, stubTheme)[0]).toStartWith(
      "j1<muted> ⬝ </muted><error>failed</error>"
    );
    expect(failed.body?.[0]).toEqual({
      kind: "notice",
      severity: "error",
      text: "Subagent failed: error. Error: boom.",
    });
    expect(stopped.labelTone).toBe("warning");
    expect(AnsiPainter.paint(stopped.title, stubTheme)[0]).toStartWith(
      "j1<muted> ⬝ </muted><warning>stopped by agent</warning>"
    );
    expect(stopped.body?.[0]).toEqual({
      kind: "notice",
      severity: "info",
      text: "wrong approach",
    });
  });
});
