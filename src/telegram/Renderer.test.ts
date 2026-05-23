import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Api } from "grammy";

import { Renderer } from "./Renderer";
import type { Session } from "./Session";

type SentMessage = {
  readonly chatId: number;
  readonly text: string;
  readonly options: unknown;
};

type EditedMessage = {
  readonly chatId: number;
  readonly messageId: number;
  readonly text: string;
  readonly options: unknown;
};

class FakeApi {
  public readonly sent: SentMessage[] = [];
  public readonly edited: EditedMessage[] = [];

  public async sendMessage(
    chatId: number,
    text: string,
    options: unknown
  ): Promise<{ readonly message_id: number }> {
    this.sent.push({ chatId, text, options });
    return { message_id: this.sent.length };
  }

  public async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    options: unknown
  ): Promise<void> {
    this.edited.push({ chatId, messageId, text, options });
  }

  public async sendChatAction(): Promise<void> {}
}

const session = {
  id: { chatId: 123, threadId: undefined },
  settings: { logsMode: "text" },
} as unknown as Session;

function makeRenderer(): {
  readonly api: FakeApi;
  readonly renderer: Renderer;
} {
  const api = new FakeApi();
  return { api, renderer: new Renderer(session, api as unknown as Api) };
}

function todoStart(
  todos: readonly unknown[],
  toolCallId = "todo-1"
): AgentSessionEvent {
  return todoStartWithArgs({ todos }, toolCallId);
}

function todoStartWithArgs(
  args: unknown,
  toolCallId = "todo-1"
): AgentSessionEvent {
  return {
    type: "tool_execution_start",
    toolCallId,
    toolName: "todo",
    args,
  } as AgentSessionEvent;
}

function todoEnd(
  todos: readonly unknown[],
  toolCallId = "todo-1"
): AgentSessionEvent {
  return {
    type: "tool_execution_end",
    toolCallId,
    toolName: "todo",
    result: { content: [], details: { todos } },
    isError: false,
  } as AgentSessionEvent;
}

function assistantText(text: string): readonly AgentSessionEvent[] {
  return [
    { type: "message_start" } as AgentSessionEvent,
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: text },
    } as AgentSessionEvent,
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_end", content: text },
    } as AgentSessionEvent,
    {
      type: "message_end",
      message: { role: "assistant", stopReason: "toolUse" },
    } as AgentSessionEvent,
  ];
}

async function flush(renderer: Renderer): Promise<void> {
  await (
    renderer as unknown as {
      readonly flushEdit: (state: "running") => Promise<void>;
    }
  ).flushEdit("running");
}

describe("Telegram Renderer todo status", () => {
  test("renders the latest in-progress todo in bold", async () => {
    const { api, renderer } = makeRenderer();

    renderer.handleEvent(
      todoStart([
        { content: "First task", status: "in_progress" },
        { content: "Second <task> & verify", status: "in_progress" },
      ])
    );
    await renderer.finish("", "ok");

    expect(api.sent.map((msg) => msg.text)).toEqual([
      "📋 <b>Second &lt;task&gt; &amp; verify</b>",
    ]);
  });

  test("keeps todo entries in event order instead of replacing the prior one", async () => {
    const { api, renderer } = makeRenderer();

    renderer.handleEvent(
      todoStart([{ content: "Remember to buy milk", status: "in_progress" }])
    );
    await flush(renderer);

    for (const event of assistantText(
      "First item is in progress. Now let me finish it and start the next one:"
    )) {
      renderer.handleEvent(event);
    }
    renderer.handleEvent(
      todoStart(
        [
          { content: "Remember to buy milk", status: "completed" },
          { content: "Remember to get water", status: "in_progress" },
        ],
        "todo-2"
      )
    );
    await renderer.finish("", "ok");

    expect(api.sent.map((msg) => msg.text)).toEqual([
      "📋 <b>Remember to buy milk</b>",
    ]);
    expect(api.edited.map((msg) => msg.text)).toEqual([
      [
        "📋 <b>Remember to buy milk</b>",
        "",
        "First item is in progress. Now let me finish it and start the next one:",
        "",
        "📋 <b>Remember to get water</b>",
      ].join("\n"),
    ]);
  });

  test("does not render todo calls with no in-progress item", async () => {
    const { api, renderer } = makeRenderer();

    renderer.handleEvent(
      todoStart([
        { content: "Plan", status: "pending" },
        { content: "Done", status: "completed" },
      ])
    );
    await renderer.finish("", "ok");

    expect(api.sent).toEqual([]);
    expect(api.edited).toEqual([]);
  });

  test("ignores malformed todo args", async () => {
    const { api, renderer } = makeRenderer();

    expect(() =>
      renderer.handleEvent(todoStartWithArgs({ text: "done" }))
    ).not.toThrow();
    await renderer.finish("", "ok");

    expect(api.sent).toEqual([]);
    expect(api.edited).toEqual([]);
  });

  test("does not emit a new todo entry when no item remains in progress", async () => {
    const { api, renderer } = makeRenderer();

    renderer.handleEvent(
      todoStart([{ content: "Build feature", status: "in_progress" }])
    );
    await flush(renderer);
    renderer.handleEvent(
      todoEnd([{ content: "Build feature", status: "completed" }])
    );
    await flush(renderer);

    expect(api.sent.map((msg) => msg.text)).toEqual([
      "📋 <b>Build feature</b>",
    ]);
    expect(api.edited).toEqual([]);
  });
});
