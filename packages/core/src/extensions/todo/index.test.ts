import { describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { TodoItem } from "./schema";
import registerTodo from "./index";
import { getCurrentItems } from "./todo";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type RegisteredTool = {
  readonly executionMode?: string;
  readonly execute: (...args: readonly unknown[]) => unknown;
};
type AppendedEntry = {
  readonly customType: string;
  readonly data: unknown;
};
type SentMessage = {
  readonly message: unknown;
  readonly options: unknown;
};
type MockPi = {
  readonly api: ExtensionAPI;
  readonly handlers: Map<string, Handler[]>;
  readonly tools: RegisteredTool[];
  readonly appendedEntries: AppendedEntry[];
  readonly sentMessages: SentMessage[];
};
type WidgetUpdate = {
  readonly id: string;
  readonly lines: readonly string[] | undefined;
};

type MockContext = ExtensionContext & {
  readonly widgetUpdates: WidgetUpdate[];
};

const stubTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `**${text}**`,
  strikethrough: (text: string) => `~~${text}~~`,
} as unknown as Theme;

describe("todo extension", () => {
  test("clears an all-done widget on the next user input", async () => {
    const pi = createPi();
    const ctx = createContext();
    registerTodo(pi.api);

    await setTodos(pi, ctx, [
      { content: "Ship it", status: "completed" },
      { content: "Skip obsolete", status: "cancelled" },
    ]);
    await emit(pi, "turn_end", { type: "turn_end" }, ctx);
    await flush();

    expect(ctx.widgetUpdates.at(-1)?.lines).toEqual([
      "**2 todos** (1 done, 1 cancelled)",
      "<success>✔</success> <muted>Ship it</muted>",
      "<muted>✘</muted> <muted>~~Skip obsolete~~</muted>",
    ]);

    const results = await emit(pi, "input", { type: "input" }, ctx);

    expect(results).toEqual([{ action: "continue" }]);
    expect(getCurrentItems(ctx.sessionManager)).toEqual([]);
    expect(ctx.widgetUpdates.at(-1)).toEqual({
      id: "pim-todo",
      lines: undefined,
    });
  });

  test("keeps the widget when any todo is still active", async () => {
    const pi = createPi();
    const ctx = createContext();
    registerTodo(pi.api);

    const todos: readonly TodoItem[] = [
      { content: "Done", status: "completed" },
      { content: "Next", status: "pending" },
    ];
    await setTodos(pi, ctx, todos);
    await emit(pi, "turn_end", { type: "turn_end" }, ctx);
    await flush();
    const updatesBeforeInput = ctx.widgetUpdates.length;

    const results = await emit(pi, "input", { type: "input" }, ctx);

    expect(results).toEqual([{ action: "continue" }]);
    expect(getCurrentItems(ctx.sessionManager)).toEqual(todos);
    expect(ctx.widgetUpdates).toHaveLength(updatesBeforeInput);
  });

  test("checkpoints todo state on session_compact so the widget survives a reload", async () => {
    const pi = createPi();
    const ctx = createContext();
    registerTodo(pi.api);

    const todos: readonly TodoItem[] = [
      { content: "Ship", status: "in_progress" },
      { content: "Verify", status: "pending" },
    ];
    await setTodos(pi, ctx, todos);
    await emit(pi, "session_compact", { type: "session_compact" }, ctx);

    expect(pi.appendedEntries).toEqual([
      { customType: "pim-todo-state", data: { todos } },
    ]);
    expect(pi.sentMessages).toEqual([
      {
        message: {
          customType: "pim-todo-snapshot",
          content: "Current todo list:\n[>] Ship\n[ ] Verify",
          display: false,
        },
        options: { triggerTurn: false },
      },
    ]);
  });

  test("session_compact is a no-op when there are no items", async () => {
    const pi = createPi();
    const ctx = createContext();
    registerTodo(pi.api);

    await emit(pi, "session_compact", { type: "session_compact" }, ctx);

    expect(pi.appendedEntries).toEqual([]);
    expect(pi.sentMessages).toEqual([]);
  });

  test("subagent ctx mutating todos does not leak into the parent ctx", async () => {
    const pi = createPi();
    const parent = createContext();
    const child = createContext();
    registerTodo(pi.api);

    await setTodos(pi, parent, [{ content: "parent", status: "pending" }]);
    await setTodos(pi, child, [{ content: "child", status: "in_progress" }]);

    expect(getCurrentItems(parent.sessionManager)).toEqual([
      { content: "parent", status: "pending" },
    ]);
    expect(getCurrentItems(child.sessionManager)).toEqual([
      { content: "child", status: "in_progress" },
    ]);
  });

  test("todo tool executes sequentially and returns a compact update summary", async () => {
    const pi = createPi();
    const ctx = createContext();
    registerTodo(pi.api);

    expect(pi.tools[0]?.executionMode).toBe("sequential");
    expect(await setTodos(pi, ctx, [])).toEqual({
      content: [
        {
          type: "text",
          text: "Todos cleared.",
        },
      ],
      details: {
        todos: [],
        summary: {
          pending: 0,
          in_progress: 0,
          completed: 0,
          cancelled: 0,
        },
      },
    });
  });
});

function createPi(): MockPi {
  const handlers = new Map<string, Handler[]>();
  const tools: RegisteredTool[] = [];
  const appendedEntries: AppendedEntry[] = [];
  const sentMessages: SentMessage[] = [];
  const api = {
    on(event: string, handler: Handler): void {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
    registerTool(tool: RegisteredTool): void {
      tools.push(tool);
    },
    appendEntry(customType: string, data: unknown): void {
      appendedEntries.push({ customType, data });
    },
    sendMessage(message: unknown, options: unknown): void {
      sentMessages.push({ message, options });
    },
  } as unknown as ExtensionAPI;

  return { api, handlers, tools, appendedEntries, sentMessages };
}

function createContext(): MockContext {
  const widgetUpdates: WidgetUpdate[] = [];
  return {
    hasUI: true,
    sessionManager: {},
    ui: {
      theme: stubTheme,
      setWidget(id: string, lines: readonly string[] | undefined): void {
        widgetUpdates.push({ id, lines });
      },
    },
    widgetUpdates,
  } as unknown as MockContext;
}

async function emit(
  pi: MockPi,
  event: string,
  payload: unknown,
  ctx: ExtensionContext
): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const handler of pi.handlers.get(event) ?? []) {
    results.push(await handler(payload, ctx));
  }
  return results;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function setTodos(
  pi: MockPi,
  ctx: ExtensionContext,
  todos: readonly TodoItem[]
): Promise<unknown> {
  const tool = pi.tools[0];
  if (!tool) {
    throw new Error("todo tool was not registered");
  }
  return await tool.execute("todo-call", { todos }, undefined, undefined, ctx);
}
