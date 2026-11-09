import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { Api } from "grammy";
import { afterAll, expect, spyOn, test } from "bun:test";

import { SubagentResult } from "#core/extensions/subagent/SubagentResult";
import type { Session } from "./Session";
import { Turn } from "./Turn";

const quietLog = spyOn(console, "log").mockImplementation(() => {});
const quietError = spyOn(console, "error").mockImplementation(() => {});
afterAll(() => {
  quietLog.mockRestore();
  quietError.mockRestore();
});

class FakeApi {
  public readonly sent: string[] = [];
  public readonly actions: string[] = [];

  public async sendRichMessage(
    _chatId: number,
    rich: { readonly html: string }
  ): Promise<{ readonly message_id: number }> {
    this.sent.push(rich.html);
    return { message_id: this.sent.length };
  }

  public async sendChatAction(_chatId: number, action: string): Promise<void> {
    this.actions.push(action);
  }
}

class FakeAgent {
  public readonly messages: unknown[] = [];
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();

  public subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public emit(event: Record<string, unknown>): void {
    for (const listener of this.listeners) {
      listener(event as AgentSessionEvent);
    }
  }

  public begin(): void {
    this.emit({ type: "agent_start" });
  }

  public reply(text: string, stopReason = "stop"): void {
    this.messages.push({
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason,
    });
  }

  public settle(aborted = false): void {
    this.emit({ type: "agent_settled", aborted });
  }

  public get listening(): number {
    return this.listeners.size;
  }
}

const session = {
  id: { chatId: 9, threadId: undefined },
  settings: { logsMode: "text" },
  cwd: "/repo",
} as unknown as Session;

function setup() {
  const api = new FakeApi();
  const agent = new FakeAgent();
  const run = (start: (agent: FakeAgent) => Promise<void>) =>
    Turn.run(
      session,
      api as unknown as Api,
      agent as unknown as AgentSession,
      () => start(agent)
    );
  return { api, agent, run };
}

test("sends the answer of the run that `start` began, typing meanwhile", async () => {
  const { api, agent, run } = setup();

  await run(async (fake) => {
    fake.begin();
    fake.reply("the job found three bugs");
    fake.settle();
  });

  expect(api.actions).toEqual(["typing"]);
  expect(api.sent).toEqual(["<p>the job found three bugs</p>"]);
  expect(agent.listening).toBe(0);
});

test("resends no earlier answer when `start` ran nothing", async () => {
  const { api, agent, run } = setup();
  agent.reply("an answer from a previous turn");

  await run(async () => {});

  expect(api.sent).toEqual([]);
});

test("renders nothing for a result appended without a run", async () => {
  const { api, run } = setup();

  await run(async (fake) => {
    const result = {
      role: "custom",
      customType: SubagentResult.CUSTOM_TYPE,
      content: "[subagent job j1 done]\nfound three bugs",
      display: true,
      details: {
        jobId: "call-1",
        handle: "j1",
        prompt: "audit",
        state: "done",
        usage: { cost: 0, turns: 1, contextTokens: 0 },
      },
    };
    fake.emit({ type: "message_start", message: result });
    fake.emit({ type: "message_end", message: result });
  });

  expect(api.actions).toEqual([]);
  expect(api.sent).toEqual([]);
});

test("reports a run that throws", async () => {
  const { api, agent, run } = setup();

  await run(async () => {
    throw new Error("No API key for test/echo");
  });

  expect(api.sent).toEqual(["<p>⚠️ No API key for test/echo</p>"]);
  expect(agent.listening).toBe(0);
});

test("sends no partial answer from an aborted run", async () => {
  const { api, run } = setup();

  await run(async (fake) => {
    fake.begin();
    fake.reply("half an answ");
    fake.settle(true);
  });

  expect(api.sent).toEqual([]);
});
