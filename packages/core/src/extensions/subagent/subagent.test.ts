import { describe, expect, jest, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import bashExtension from "../bash/index";
import readExtension from "../read/index";
import {
  applyOutputCap,
  childLoaderOptions,
  childSession,
  runSubagent,
  startSubagent,
  SubagentEventCapture,
  UPDATE_INTERVAL_MS,
  type SubagentDetails,
  type SubagentSessionSpec,
} from "./subagent";
import { until } from "../../shared/fixtures/wait";
import {
  assistant,
  FakeSession,
  HeldSession,
  parent,
  usage,
} from "./fixtures/session";

describe("childLoaderOptions", () => {
  test("gives the child pim's own roster, not pi's built-ins alone", () => {
    const names = childLoaderOptions("/work").extensionFactories.map(
      (entry) => entry.name
    );

    expect(names).toContain("glob");
    expect(names).toContain("web-search");
    expect(names).toContain("apply-patch");
  });

  test("leaves out subagent, so a child can never spawn one", () => {
    const names = childLoaderOptions("/work").extensionFactories.map(
      (entry) => entry.name
    );

    expect(names).not.toContain("subagent");
  });
});

describe("SubagentEventCapture", () => {
  test("keeps every message in order, and no trace of the tools between them", () => {
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
    expect(capture.narration()).toBe("first turn\n\nfinal answer");
    expect(snapshot.usage).toEqual({
      input: 12,
      output: 12,
      cacheRead: 3,
      cacheWrite: 0,
      cost: 0.03,
      turns: 2,
      contextTokens: undefined,
    });
    expect(updates.at(-1)).toBe("2 turns ⬝ $0.03");
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

    expect(capture.details().fullOutput).toBe("partial");
    expect(capture.details().returnedOutput).toBe("partial");
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

    // A surviving flushed timer would show up as an extra update here.
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

  test("dispose drops an update the run no longer wants", () => {
    const updates: SubagentDetails[] = [];
    const capture = new SubagentEventCapture((partial) =>
      updates.push(partial.details)
    );

    jest.useFakeTimers();
    try {
      capture.handle({
        type: "message_update",
        message: assistant(["orphan"]),
      } as never);
      capture.dispose();

      jest.advanceTimersByTime(UPDATE_INTERVAL_MS * 2);
      expect(updates).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
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

    const result = await runSubagent("say hi", parent, {
      createSession: async () => fake,
    });

    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
    expect(result.details.fullOutput).toBe("hello");
    expect(fake.promptCalls).toBe(1);
    expect(fake.abortCalls).toBe(1);
    expect(fake.disposeCalls).toBe(1);
  });

  test("hands the parent's thinking level to the child session", async () => {
    const fake = new FakeSession(async () => {});
    const specs: SubagentSessionSpec[] = [];

    await runSubagent("think", parent, {
      thinkingLevel: "high",
      createSession: async (_parent, spec) => {
        specs.push(spec);
        return fake;
      },
    });

    expect(specs.map((spec) => spec.thinkingLevel)).toEqual(["high"]);
  });

  test("returns a hint, not an error, for normal empty output", async () => {
    const fake = new FakeSession(async (session) => {
      session.emit({ type: "message_start", message: assistant([]) });
      session.emit({ type: "message_end", message: assistant([]) });
    });

    const result = await runSubagent("empty", parent, {
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
      runSubagent("fail", parent, { createSession: async () => fake })
    ).rejects.toThrow(
      "Subagent failed: error. Error: provider exploded.\nPartial output before failure:\npartial"
    );
  });

  test("rejects pre-aborted signals before prompt", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = new FakeSession(async () => {});

    await expect(
      runSubagent("abort", parent, {
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
    const promise = runSubagent("long", parent, {
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

  // A job notice wakes the parent from inside the child's onChange; that turn's spawns are the parent's own.
  test("the parent can spawn from a callback the child fires", async () => {
    let spawned: Promise<unknown> | undefined;
    const child = new FakeSession(async (session) => {
      session.emit({ type: "message_end", message: assistant(["done"]) });
    });

    await runSubagent("outer", parent, {
      createSession: async () => child,
      onChange: () => {
        spawned ??= runSubagent("sibling", parent, {
          createSession: async () =>
            new FakeSession(async (session) => {
              session.emit({ type: "message_end", message: assistant(["ok"]) });
            }),
        });
      },
    });

    expect(await spawned).toMatchObject({ content: [{ text: "ok" }] });
  });
});

describe("SubagentEventCapture tools", () => {
  const fakePi = {
    registerTool: () => {},
    on: () => {},
    getActiveTools: () => [],
    getAllTools: () => [],
  } as unknown as ExtensionAPI;
  readExtension(fakePi);
  bashExtension(fakePi);

  function toolStart(id: string, toolName: string, args: unknown): never {
    return {
      type: "tool_execution_start",
      toolCallId: id,
      toolName,
      args,
    } as never;
  }

  function toolEnd(id: string, toolName: string, isError = false): never {
    return {
      type: "tool_execution_end",
      toolCallId: id,
      toolName,
      result: {},
      isError,
    } as never;
  }

  test("names each tool by its row title, or the generic one without a view", () => {
    const capture = new SubagentEventCapture(undefined, { cwd: "/work" });

    capture.handle(toolStart("1", "read", { path: "/work/src/app.ts" }));
    capture.handle(toolStart("2", "mcp_lookup", { query: "foo" }));

    expect(capture.recentTools()).toEqual([
      { title: "Read src/app.ts", state: "running" },
      { title: "mcp_lookup foo", state: "running" },
    ]);
  });

  test("remembers the last ten tool calls with their outcome", () => {
    const capture = new SubagentEventCapture(undefined, { cwd: "/work" });

    for (let i = 0; i < 12; i += 1) {
      capture.handle(toolStart(`${i}`, "bash", { command: `step ${i}` }));
      capture.handle(toolEnd(`${i}`, "bash", i === 11));
    }
    capture.handle(toolStart("12", "bash", { command: "step 12" }));

    const recent = capture.recentTools();
    expect(recent).toHaveLength(10);
    expect(recent[0]).toEqual({ title: "Bash step 3", state: "done" });
    expect(recent.at(-2)).toEqual({ title: "Bash step 11", state: "error" });
    expect(recent.at(-1)).toEqual({ title: "Bash step 12", state: "running" });
  });

  test("a tool starting or ending is an update of its own", () => {
    const updates: string[] = [];
    const capture = new SubagentEventCapture(() => {
      updates.push(capture.recentTools().at(-1)?.state ?? "");
    });

    capture.handle(toolStart("1", "bash", { command: "ls" }));
    capture.handle(toolEnd("1", "bash", true));

    expect(updates).toEqual(["running", "error"]);
    expect(capture.recentTools()).toEqual([
      { title: "Bash ls", state: "error" },
    ]);
  });
});

describe("childSession", () => {
  test("steers the child's agent with the text as is, never as a command or template", async () => {
    const steered: unknown[] = [];
    const agent = {
      sessionId: "child",
      agent: { steer: (message: unknown) => steered.push(message) },
      steer: () => {
        throw new Error("expands templates");
      },
    };

    await childSession(agent as never).steer("/review the parser");

    expect(steered).toMatchObject([
      {
        role: "user",
        content: [{ type: "text", text: "/review the parser" }],
      },
    ]);
  });
});

describe("startSubagent", () => {
  test("returns before the child finishes, with its capture reachable", async () => {
    const held = new HeldSession();
    const child = startSubagent("long", parent, {
      createSession: async () => held,
    });

    await until(() => held.promptCalls === 1, "the child to be prompted");
    held.emit({ type: "message_update", message: assistant(["thinking"]) });
    expect(child.capture.narration()).toBe("thinking");

    held.finish("done");
    expect((await child.result).details.returnedOutput).toBe("done");
  });

  test("steers the child's session, waiting for it to exist", async () => {
    const held = new HeldSession();
    const created = Promise.withResolvers<void>();
    const child = startSubagent("long", parent, {
      createSession: async () => {
        await created.promise;
        return held;
      },
    });

    const steered = child.steer("also check the tests");
    created.resolve();
    await steered;

    expect(held.steered).toEqual(["also check the tests"]);
    held.finish("done");
    await child.result;
  });

  test("stop aborts the child and resolves once it has settled", async () => {
    const held = new HeldSession();
    const child = startSubagent("long", parent, {
      createSession: async () => held,
    });
    await until(() => held.promptCalls === 1, "the child to be prompted");

    await child.stop();

    expect(held.abortCalls).toBe(1);
    expect(held.disposeCalls).toBe(1);
    await expect(child.result).rejects.toThrow("Subagent failed: aborted");
  });

  test("a child that never started cannot be steered", async () => {
    const child = startSubagent("boom", parent, {
      createSession: async () => {
        throw new Error("no model");
      },
    });

    await expect(child.result).rejects.toThrow("no model");
    await expect(child.steer("hello")).rejects.toThrow("never started");
  });
});
