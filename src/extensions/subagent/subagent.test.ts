import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
  applyOutputCap,
  childToolNames,
  runSubagent,
  SubagentEventCapture,
  type SubagentSession,
} from "./subagent";

type UsageOverrides = Omit<Partial<Usage>, "cost"> & {
  readonly cost?: Partial<Usage["cost"]>;
};

const usage = (overrides: UsageOverrides = {}): Usage => {
  const { cost, ...rest } = overrides;
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      ...cost,
    },
    ...rest,
  };
};

function assistant(
  textParts: readonly string[],
  overrides: Partial<AssistantMessage> = {}
): AssistantMessage {
  return {
    role: "assistant",
    content: textParts.map((text) => ({ type: "text", text })),
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-test",
    usage: usage(),
    stopReason: "stop",
    timestamp: 1,
    ...overrides,
  };
}

const ctx = { cwd: "/work" } as ExtensionContext;

class FakeSession implements SubagentSession {
  public promptCalls = 0;
  public abortCalls = 0;
  public disposeCalls = 0;
  private listener: ((event: never) => void) | undefined;

  public constructor(
    private readonly onPrompt: (
      session: FakeSession,
      prompt: string
    ) => Promise<void>
  ) {}

  public subscribe(listener: (event: never) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  public emit(event: unknown): void {
    this.listener?.(event as never);
  }

  public async prompt(prompt: string): Promise<void> {
    this.promptCalls += 1;
    await this.onPrompt(this, prompt);
  }

  public async abort(): Promise<void> {
    this.abortCalls += 1;
  }

  public dispose(): void {
    this.disposeCalls += 1;
  }
}

describe("childToolNames", () => {
  test("removes the subagent tool from a child's inherited allowlist", () => {
    expect(childToolNames(["read", "subagent", "bash"])).toEqual([
      "read",
      "bash",
    ]);
  });
});

describe("SubagentEventCapture", () => {
  test("concatenates multi-part text, resets for each assistant message, and records usage/tools", () => {
    const updates: string[] = [];
    const capture = new SubagentEventCapture((partial) => {
      updates.push(
        partial.content[0]?.type === "text" ? partial.content[0].text : ""
      );
    });

    capture.handle({ type: "message_start", message: assistant([]) } as never);
    capture.handle({
      type: "message_end",
      message: assistant(["first ", "turn"], {
        usage: usage({ input: 10, output: 4, cost: { total: 0.01 } }),
      }),
    } as never);
    capture.handle({
      type: "tool_execution_end",
      toolCallId: "1",
      toolName: "read",
      result: {},
      isError: false,
    } as never);
    capture.handle({ type: "message_start", message: assistant([]) } as never);
    capture.handle({
      type: "message_end",
      message: assistant(["final", " answer"], {
        usage: usage({
          input: 2,
          output: 8,
          cacheRead: 3,
          cost: { total: 0.02 },
        }),
      }),
    } as never);

    const snapshot = capture.snapshot();
    expect(snapshot.finalOutput).toBe("final answer");
    expect(snapshot.usage).toEqual({
      input: 12,
      output: 12,
      cacheRead: 3,
      cacheWrite: 0,
      cost: 0.03,
      turns: 2,
      contextTokens: undefined,
    });
    expect(snapshot.toolCalls).toEqual([{ name: "read", isError: false }]);
    expect(snapshot.lastToolName).toBe("read");
    expect(updates.at(-1)).toBe("$0.03 ⬝ ?/? ⬝ claude-test ⬝ 2 turns ⬝ 1 tool");
  });

  test("a later message with no text discards the prior message's text", () => {
    const capture = new SubagentEventCapture();

    capture.handle({ type: "message_start", message: assistant([]) } as never);
    capture.handle({
      type: "message_end",
      message: assistant(["intro"], { stopReason: "toolUse" }),
    } as never);
    capture.handle({ type: "message_start", message: assistant([]) } as never);
    capture.handle({
      type: "message_end",
      message: assistant([], { stopReason: "stop" }),
    } as never);

    expect(capture.snapshot().finalOutput).toBe("");
  });

  test("message_update content is materialized lazily on snapshot read", () => {
    const capture = new SubagentEventCapture();

    capture.handle({ type: "message_start", message: assistant([]) } as never);
    capture.handle({
      type: "message_update",
      message: assistant(["partial"]),
    } as never);

    expect(capture.snapshot().finalOutput).toBe("partial");
  });
});

describe("applyOutputCap", () => {
  test("truncates on a UTF-8 boundary and reports omitted bytes", () => {
    const capped = applyOutputCap("😀😀😀", 5);

    expect(capped.text).toContain(
      "😀\n[subagent: output truncated, 8 bytes omitted"
    );
    expect(capped.text).not.toContain("�");
    expect(capped.truncated).toBe(true);
    expect(capped.omittedBytes).toBe(8);
  });
});

describe("runSubagent", () => {
  test("returns bare text on normal completion", async () => {
    const fake = new FakeSession(async (session) => {
      session.emit({ type: "message_start", message: assistant([]) });
      session.emit({
        type: "message_end",
        message: assistant(["hello"]),
      });
    });

    const result = await runSubagent(
      "say hi",
      ctx,
      undefined,
      undefined,
      async () => fake
    );

    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
    expect(result.details.fullOutput).toBe("hello");
    expect(fake.promptCalls).toBe(1);
    expect(fake.abortCalls).toBe(1);
    expect(fake.disposeCalls).toBe(1);
  });

  test("returns a hint, not an error, for normal empty output", async () => {
    const fake = new FakeSession(async (session) => {
      session.emit({ type: "message_start", message: assistant([]) });
      session.emit({ type: "message_end", message: assistant([]) });
    });

    const result = await runSubagent(
      "empty",
      ctx,
      undefined,
      undefined,
      async () => fake
    );

    expect(
      result.content[0]?.type === "text" ? result.content[0].text : ""
    ).toBe("[subagent tool: completed with no text output.]");
  });

  test("throws on model error with partial output", async () => {
    const fake = new FakeSession(async (session) => {
      session.emit({ type: "message_start", message: assistant([]) });
      session.emit({
        type: "message_end",
        message: assistant(["partial"], {
          stopReason: "error",
          errorMessage: "provider exploded",
        }),
      });
    });

    await expect(
      runSubagent("fail", ctx, undefined, undefined, async () => fake)
    ).rejects.toThrow(
      "Subagent failed: error. Error: provider exploded.\nPartial output before failure:\npartial"
    );
  });

  test("rejects pre-aborted signals before prompt", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = new FakeSession(async () => {});

    await expect(
      runSubagent("abort", ctx, controller.signal, undefined, async () => fake)
    ).rejects.toThrow("Subagent failed: subagent aborted before start");

    expect(fake.promptCalls).toBe(0);
    expect(fake.abortCalls).toBe(1);
    expect(fake.disposeCalls).toBe(1);
  });

  test("mid-run abort aborts once, tears down, and rejects", async () => {
    let finishPrompt: (() => void) | undefined;
    const fake = new (class extends FakeSession {
      public override async abort(): Promise<void> {
        await super.abort();
        finishPrompt?.();
      }
    })(
      () =>
        new Promise<void>((resolve) => {
          finishPrompt = resolve;
        })
    );
    const controller = new AbortController();
    const promise = runSubagent(
      "long",
      ctx,
      controller.signal,
      undefined,
      async () => fake
    );

    await Promise.resolve();
    controller.abort();

    await expect(promise).rejects.toThrow("Subagent failed: aborted");
    expect(fake.promptCalls).toBe(1);
    expect(fake.abortCalls).toBe(1);
    expect(fake.disposeCalls).toBe(1);
  });

  test("nested subagent calls are rejected by the async-local recursion ban", async () => {
    const outer = new FakeSession(async () => {
      const inner = new FakeSession(async () => {});
      await runSubagent("inner", ctx, undefined, undefined, async () => inner);
    });

    await expect(
      runSubagent("outer", ctx, undefined, undefined, async () => outer)
    ).rejects.toThrow("subagents cannot call subagent tool");
  });
});
