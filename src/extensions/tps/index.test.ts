import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { PimSettings } from "../../shared/PimSettings";
import registerTps from "./index";

type Handler = (event: unknown, ctx: unknown) => unknown;

type MockPi = {
  readonly api: ExtensionAPI;
  readonly handlers: Map<string, Handler[]>;
};

const originalNow = Date.now;
const originalGet = PimSettings.get;

let now = 0;

function createPi(): MockPi {
  const handlers = new Map<string, Handler[]>();
  const api = {
    on(event: string, handler: Handler): void {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
    registerCommand(): void {},
  } as unknown as ExtensionAPI;

  return { api, handlers };
}

async function emit(
  pi: MockPi,
  event: string,
  payload: unknown,
  ctx: unknown
): Promise<void> {
  for (const handler of pi.handlers.get(event) ?? []) {
    await handler(payload, ctx);
  }
}

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
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  },
  stopReason: "stop",
  timestamp: 1000,
} as const;

describe("tps extension", () => {
  beforeEach(() => {
    now = 0;
    Date.now = () => now;
    Object.defineProperty(PimSettings, "get", {
      value: async () => ({ enabled: true }),
    });
  });

  afterEach(() => {
    Date.now = originalNow;
    Object.defineProperty(PimSettings, "get", { value: originalGet });
  });

  test("reports metrics when stream updates and final message are different objects", async () => {
    const pi = createPi();
    const notifications: string[] = [];
    const ctx = {
      hasUI: true,
      ui: {
        notify(message: string): void {
          notifications.push(message);
        },
      },
    };

    registerTps(pi.api);

    await emit(pi, "agent_start", { type: "agent_start" }, ctx);

    now = 1000;
    await emit(
      pi,
      "before_provider_request",
      { type: "before_provider_request", payload: {} },
      ctx
    );

    now = 1150;
    await emit(
      pi,
      "message_update",
      {
        type: "message_update",
        message: { ...assistantMessage },
        assistantMessageEvent: {
          type: "text_start",
          contentIndex: 0,
          partial: assistantMessage,
        },
      },
      ctx
    );

    now = 1200;
    await emit(
      pi,
      "message_update",
      {
        type: "message_update",
        message: { ...assistantMessage },
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "h",
          partial: assistantMessage,
        },
      },
      ctx
    );

    now = 2200;
    await emit(
      pi,
      "message_end",
      { type: "message_end", message: assistantMessage },
      ctx
    );
    await emit(
      pi,
      "agent_end",
      { type: "agent_end", messages: [assistantMessage] },
      ctx
    );

    expect(notifications).toEqual([
      "Decode: 50.0 tps | Prefill: 5500.0 tps | Cache read: 5,000 | TTFT: 0.20s",
    ]);
  });

  test("reports once at the end of a multi-turn agent cycle", async () => {
    const pi = createPi();
    const notifications: string[] = [];
    const ctx = {
      hasUI: true,
      ui: {
        notify(message: string): void {
          notifications.push(message);
        },
      },
    };

    registerTps(pi.api);

    await emit(pi, "agent_start", { type: "agent_start" }, ctx);

    now = 1000;
    await emit(
      pi,
      "before_provider_request",
      { type: "before_provider_request", payload: {} },
      ctx
    );
    now = 1200;
    await emit(
      pi,
      "message_update",
      {
        type: "message_update",
        message: { ...assistantMessage },
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "thinking",
          partial: assistantMessage,
        },
      },
      ctx
    );
    now = 2200;
    await emit(
      pi,
      "message_end",
      { type: "message_end", message: assistantMessage },
      ctx
    );
    await emit(
      pi,
      "turn_end",
      { type: "turn_end", message: assistantMessage, toolResults: [] },
      ctx
    );

    now = 3000;
    await emit(
      pi,
      "before_provider_request",
      { type: "before_provider_request", payload: {} },
      ctx
    );
    now = 3200;
    await emit(
      pi,
      "message_update",
      {
        type: "message_update",
        message: { ...assistantMessage },
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "h",
          partial: assistantMessage,
        },
      },
      ctx
    );
    now = 4200;
    await emit(
      pi,
      "message_end",
      { type: "message_end", message: assistantMessage },
      ctx
    );

    expect(notifications).toEqual([]);

    await emit(
      pi,
      "agent_end",
      { type: "agent_end", messages: [assistantMessage, assistantMessage] },
      ctx
    );

    expect(notifications).toEqual([
      "Decode: 50.0 tps | Prefill: 5500.0 tps | Cache read: 10,000 | TTFT: 0.20s",
    ]);
  });
});
