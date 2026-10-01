import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerTps from "./index";

type Handler = (event: unknown, ctx: unknown) => unknown;

const originalNow = Date.now;
let now = 0;

const assistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "hello" }],
  api: "openai",
  provider: "openai",
  model: "test-model",
  usage: {
    input: 1000,
    output: 50,
    cacheRead: 5000,
    cacheWrite: 100,
    totalTokens: 6150,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 1000,
} as const;

function setup() {
  const handlers = new Map<string, Handler[]>();
  const api = {
    on(event: string, handler: Handler): void {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(): void {},
  } as unknown as ExtensionAPI;
  const notifications: string[] = [];
  const ctx = {
    hasUI: true,
    ui: { notify: (message: string) => notifications.push(message) },
  };
  registerTps(api);

  const emit = async (event: string, payload: unknown, at = now) => {
    now = at;
    for (const handler of handlers.get(event) ?? []) {
      await handler({ type: event, ...(payload as object) }, ctx);
    }
  };
  const update = (at: number, type: string, delta?: string) =>
    emit(
      "message_update",
      {
        message: { ...assistantMessage },
        assistantMessageEvent: {
          type,
          contentIndex: 0,
          ...(delta === undefined ? {} : { delta }),
          partial: assistantMessage,
        },
      },
      at
    );
  const request = (at: number) =>
    emit("before_provider_request", { payload: {} }, at);
  const end = (at: number) =>
    emit("message_end", { message: assistantMessage }, at);

  return { emit, update, request, end, notifications };
}

describe("tps extension", () => {
  beforeEach(() => {
    now = 0;
    Date.now = () => now;
  });

  afterEach(() => {
    Date.now = originalNow;
  });

  test("times the first output delta, not the start event", async () => {
    const t = setup();
    await t.emit("agent_start", {});
    await t.request(1000);
    await t.update(1150, "text_start");
    await t.update(1200, "text_delta", "h");
    await t.end(2200);
    await t.emit("agent_end", { messages: [assistantMessage] });

    expect(t.notifications).toEqual([
      "Decode: 50.0 tps | Prefill: 5500.0 tps | Cache read: 5,000 | TTFT: 0.20s",
    ]);
  });

  test("reports once at the end of a multi-turn agent cycle", async () => {
    const t = setup();
    await t.emit("agent_start", {});
    await t.request(1000);
    await t.update(1200, "thinking_delta", "thinking");
    await t.end(2200);
    await t.emit("turn_end", { message: assistantMessage, toolResults: [] });
    await t.request(3000);
    await t.update(3200, "text_delta", "h");
    await t.end(4200);

    expect(t.notifications).toEqual([]);

    await t.emit("agent_end", {
      messages: [assistantMessage, assistantMessage],
    });

    expect(t.notifications).toEqual([
      "Decode: 50.0 tps | Prefill: 5500.0 tps | Cache read: 10,000 | TTFT: 0.20s",
    ]);
  });
});
