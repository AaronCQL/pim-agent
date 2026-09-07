import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
  applyOutputCap,
  childToolNames,
  childLoaderOptions,
  runSubagent,
  SubagentEventCapture,
  type SubagentDetails,
  type SubagentSession,
} from "./subagent";

/**
 * Polls a condition rather than sleeping long enough that it is probably true.
 * The deadline is well inside bun's per-test one so a stuck wait says which.
 */
async function until(ready: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await Bun.sleep(1);
  }
}

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

describe("childLoaderOptions", () => {
  test("gives the child pim's own roster, not pi's built-ins alone", () => {
    const names = childLoaderOptions("/work").extensionFactories.map(
      (entry) => entry.name
    );

    // The allowlist names tools by their registered name, so a child built
    // without the roster would resolve `glob` or `web_search` to nothing.
    expect(names).toContain("glob");
    expect(names).toContain("web-search");
    expect(names).toContain("apply-patch");
  });
});

describe("SubagentEventCapture", () => {
  test("keeps every message in order, interleaved with the tools between them", () => {
    const updates: string[] = [];
    const capture = new SubagentEventCapture((partial) => {
      updates.push(
        partial.content[0]?.type === "text" ? partial.content[0].text : ""
      );
    });

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
    expect(snapshot.entries).toEqual([
      { kind: "text", text: "first turn" },
      { kind: "tool", callId: "1", name: "read", isError: false },
      { kind: "text", text: "final answer" },
    ]);
    expect(snapshot.usage).toEqual({
      input: 12,
      output: 12,
      cacheRead: 3,
      cacheWrite: 0,
      cost: 0.03,
      turns: 2,
      contextTokens: undefined,
    });
    expect(snapshot.lastToolName).toBe("read");
    expect(updates.at(-1)).toBe("read ⬝ 2 turns ⬝ $0.03");
  });

  test("narration survives a final message that says nothing", () => {
    const capture = new SubagentEventCapture();

    capture.handle({
      type: "message_end",
      message: assistant(["intro"], { stopReason: "toolUse" }),
    } as never);
    capture.handle({
      type: "message_end",
      message: assistant([], { stopReason: "stop" }),
    } as never);

    expect(capture.details().fullOutput).toBe("intro");
  });

  test("a message still streaming reads as the entry it will become", () => {
    const capture = new SubagentEventCapture();

    capture.handle({
      type: "message_update",
      message: assistant(["partial"]),
    } as never);

    expect(capture.snapshot().entries).toEqual([
      { kind: "text", text: "partial" },
    ]);
    expect(capture.details().fullOutput).toBe("partial");
  });

  test("streams the body on a trailing throttle, not on every delta", async () => {
    const updates: SubagentDetails[] = [];
    const capture = new SubagentEventCapture((partial) =>
      updates.push(partial.details)
    );

    capture.handle({
      type: "message_update",
      message: assistant(["Read"]),
    } as never);
    capture.handle({
      type: "message_update",
      message: assistant(["Reading the confi"]),
    } as never);
    expect(updates).toEqual([]);

    await until(() => updates.length === 1, "the throttled update");
    expect(updates[0]?.fullOutput).toBe("Reading the confi");
  });

  test("message_end flushes the pending update instead of racing it", async () => {
    const updates: SubagentDetails[] = [];
    const capture = new SubagentEventCapture((partial) =>
      updates.push(partial.details)
    );

    capture.handle({
      type: "message_update",
      message: assistant(["half"]),
    } as never);
    capture.handle({
      type: "message_end",
      message: assistant(["halfway there"]),
    } as never);
    expect(updates.length).toBe(1);

    // A second stream proves the flushed timer was cancelled: had it survived
    // it would have landed here as an extra update carrying the same text.
    capture.handle({
      type: "message_update",
      message: assistant(["next"]),
    } as never);
    await until(() => updates.length === 2, "the next throttled update");

    expect(updates.map((details) => details.fullOutput)).toEqual([
      "halfway there",
      "halfway there\n\nnext",
    ]);
  });

  test("dispose drops an update the run no longer wants", async () => {
    const updates: SubagentDetails[] = [];
    const capture = new SubagentEventCapture((partial) =>
      updates.push(partial.details)
    );

    capture.handle({
      type: "message_update",
      message: assistant(["orphan"]),
    } as never);
    capture.dispose();
    capture.handle({
      type: "tool_execution_start",
      toolCallId: "1",
      toolName: "read",
    } as never);

    await until(() => updates.length === 1, "the tool update");
    expect(updates).toHaveLength(1);
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

    const result = await runSubagent("say hi", ctx, {
      createSession: async () => fake,
    });

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

    const result = await runSubagent("empty", ctx, {
      createSession: async () => fake,
    });

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
      runSubagent("fail", ctx, { createSession: async () => fake })
    ).rejects.toThrow(
      "Subagent failed: error. Error: provider exploded.\nPartial output before failure:\npartial"
    );
  });

  test("rejects pre-aborted signals before prompt", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = new FakeSession(async () => {});

    await expect(
      runSubagent("abort", ctx, {
        signal: controller.signal,
        createSession: async () => fake,
      })
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
    const promise = runSubagent("long", ctx, {
      signal: controller.signal,
      createSession: async () => fake,
    });

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
      await runSubagent("inner", ctx, { createSession: async () => inner });
    });

    await expect(
      runSubagent("outer", ctx, { createSession: async () => outer })
    ).rejects.toThrow("subagents cannot call subagent tool");
  });
});
