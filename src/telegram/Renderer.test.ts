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

type RichArg = string | { readonly html: string };

const richText = (value: RichArg): string =>
  typeof value === "string" ? value : value.html;

class FakeApi {
  public readonly sent: SentMessage[] = [];
  public readonly edited: EditedMessage[] = [];

  // Replies and status go through the typed rich-message methods; capture the
  // html they carry so assertions read it as the message text.
  public async sendRichMessage(
    chatId: number,
    richMessage: { readonly html: string },
    options: unknown
  ): Promise<{ readonly message_id: number }> {
    this.sent.push({ chatId, text: richMessage.html, options });
    return { message_id: this.sent.length };
  }

  // editMessageText takes rich content (object) on the happy path and a plain
  // string on the degrade path; both resolve to the captured text.
  public async editMessageText(
    chatId: number,
    messageId: number,
    textOrRich: RichArg,
    options?: unknown
  ): Promise<void> {
    this.edited.push({
      chatId,
      messageId,
      text: richText(textOrRich),
      options,
    });
  }

  // Plain-text degrade path, exercised only when a rich send is rejected.
  public async sendMessage(
    chatId: number,
    text: string,
    options: unknown
  ): Promise<{ readonly message_id: number }> {
    this.sent.push({ chatId, text, options });
    return { message_id: this.sent.length };
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

function applyPatchStart(
  input: unknown,
  toolCallId = "ap-1"
): AgentSessionEvent {
  return {
    type: "tool_execution_start",
    toolCallId,
    toolName: "apply_patch",
    args: input,
  } as AgentSessionEvent;
}

function applyPatchEnd(
  entries: readonly unknown[],
  toolCallId = "ap-1"
): AgentSessionEvent {
  return {
    type: "tool_execution_end",
    toolCallId,
    toolName: "apply_patch",
    result: { content: [], details: { entries } },
    isError: false,
  } as AgentSessionEvent;
}

function toolStart(
  toolName: string,
  args: unknown,
  toolCallId: string
): AgentSessionEvent {
  return {
    type: "tool_execution_start",
    toolCallId,
    toolName,
    args,
  } as AgentSessionEvent;
}

function toolEndWithDiff(
  toolName: string,
  diff: unknown,
  toolCallId: string
): AgentSessionEvent {
  return {
    type: "tool_execution_end",
    toolCallId,
    toolName,
    result: { content: [], details: { diff } },
    isError: false,
  } as AgentSessionEvent;
}

// countStats only reads diff.hunks[].lines[].kind, so a minimal shape suffices.
function fakeDiff(added: number, removed: number): unknown {
  return {
    hunks: [
      {
        lines: [
          ...Array.from({ length: added }, () => ({ kind: "added" })),
          ...Array.from({ length: removed }, () => ({ kind: "removed" })),
        ],
      },
    ],
  };
}

describe("Telegram Renderer apply_patch status", () => {
  test("labels a single update with the edit emoji and basename", async () => {
    const { api, renderer } = makeRenderer();
    renderer.handleEvent(
      applyPatchStart({
        input:
          "*** Begin Patch\n*** Update File: src/foo.ts\n@@\n-const a = 1\n+const a = 2\n*** End Patch",
      })
    );
    await renderer.finish("", "ok");
    expect(api.sent.map((m) => m.text)).toEqual(["✏️ <code>foo.ts</code>"]);
  });

  test("labels a delete with the trash emoji", async () => {
    const { api, renderer } = makeRenderer();
    renderer.handleEvent(
      applyPatchStart({
        input: "*** Begin Patch\n*** Delete File: src/old.ts\n*** End Patch",
      })
    );
    await renderer.finish("", "ok");
    expect(api.sent.map((m) => m.text)).toEqual(["🗑️ <code>old.ts</code>"]);
  });

  test("labels a rename with the edit emoji and an arrow", async () => {
    const { api, renderer } = makeRenderer();
    renderer.handleEvent(
      applyPatchStart({
        input:
          "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: src/b.ts\n*** End Patch",
      })
    );
    await renderer.finish("", "ok");
    expect(api.sent.map((m) => m.text)).toEqual([
      "✏️ <code>a.ts</code> ➝ <code>b.ts</code>",
    ]);
  });

  test("refines a move with the arrow and line stats on finish", async () => {
    const { api, renderer } = makeRenderer();
    renderer.handleEvent(
      applyPatchStart({
        input:
          "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: src/b.ts\n@@\n-x\n+y\n*** End Patch",
      })
    );
    renderer.handleEvent(
      applyPatchEnd([
        {
          action: { kind: "move", path: "src/a.ts", movePath: "src/b.ts" },
          diff: fakeDiff(1, 1),
        },
      ])
    );
    await renderer.finish("", "ok");
    expect(api.sent.map((m) => m.text)).toEqual([
      "✏️ <code>a.ts</code> ➝ <code>b.ts</code> +1/-1",
    ]);
  });

  test("renders one line per file for a mixed multi-file patch", async () => {
    const { api, renderer } = makeRenderer();
    renderer.handleEvent(
      applyPatchStart({
        input: [
          "*** Begin Patch",
          "*** Update File: src/config.ts",
          "@@",
          "-old",
          "+new",
          "*** Delete File: src/legacy.ts",
          "*** Update File: src/a.ts",
          "*** Move to: src/b.ts",
          "*** End Patch",
        ].join("\n"),
      })
    );
    await renderer.finish("", "ok");
    expect(api.sent.map((m) => m.text)).toEqual([
      [
        "✏️ <code>config.ts</code>",
        "🗑️ <code>legacy.ts</code>",
        "✏️ <code>a.ts</code> ➝ <code>b.ts</code>",
      ].join("<br>"),
    ]);
  });

  test("appends line stats from the result once the patch finishes", async () => {
    const { api, renderer } = makeRenderer();
    renderer.handleEvent(
      applyPatchStart({
        input:
          "*** Begin Patch\n*** Update File: src/foo.ts\n@@\n-const a = 1\n+const a = 2\n*** End Patch",
      })
    );
    renderer.handleEvent(
      applyPatchEnd([
        {
          action: { kind: "update", path: "src/foo.ts" },
          diff: fakeDiff(2, 3),
        },
      ])
    );
    await renderer.finish("", "ok");
    expect(api.sent.map((m) => m.text)).toEqual([
      "✏️ <code>foo.ts</code> +2/-3",
    ]);
  });

  test("shows a removal-only stat for a delete result", async () => {
    const { api, renderer } = makeRenderer();
    renderer.handleEvent(
      applyPatchStart({
        input: "*** Begin Patch\n*** Delete File: src/old.ts\n*** End Patch",
      })
    );
    renderer.handleEvent(
      applyPatchEnd([
        {
          action: { kind: "delete", path: "src/old.ts" },
          diff: fakeDiff(0, 5),
        },
      ])
    );
    await renderer.finish("", "ok");
    expect(api.sent.map((m) => m.text)).toEqual(["🗑️ <code>old.ts</code> -5"]);
  });

  test("falls back to the filename when the patch text does not parse", async () => {
    const { api, renderer } = makeRenderer();
    renderer.handleEvent(
      applyPatchStart({
        input:
          "*** Begin Patch\n*** Update File: src/weird.ts\n(garbage)\n*** End Patch",
      })
    );
    await renderer.finish("", "ok");
    expect(api.sent.map((m) => m.text)).toEqual(["✏️ <code>weird.ts</code>"]);
  });

  test("accepts a bare-string patch argument", async () => {
    const { api, renderer } = makeRenderer();
    renderer.handleEvent(
      applyPatchStart(
        "*** Begin Patch\n*** Delete File: src/old.ts\n*** End Patch"
      )
    );
    await renderer.finish("", "ok");
    expect(api.sent.map((m) => m.text)).toEqual(["🗑️ <code>old.ts</code>"]);
  });
});

describe("Telegram Renderer edit/write stats", () => {
  test("appends +added/-removed to an edit once it finishes", async () => {
    const { api, renderer } = makeRenderer();
    renderer.handleEvent(toolStart("edit", { path: "src/foo.ts" }, "e-1"));
    renderer.handleEvent(toolEndWithDiff("edit", fakeDiff(2, 1), "e-1"));
    await renderer.finish("", "ok");
    expect(api.sent.map((m) => m.text)).toEqual([
      "✏️ <code>foo.ts</code> +2/-1",
    ]);
  });

  test("shows an addition-only stat for a write", async () => {
    const { api, renderer } = makeRenderer();
    renderer.handleEvent(toolStart("write", { path: "src/bar.ts" }, "w-1"));
    renderer.handleEvent(toolEndWithDiff("write", fakeDiff(4, 0), "w-1"));
    await renderer.finish("", "ok");
    expect(api.sent.map((m) => m.text)).toEqual(["✏️ <code>bar.ts</code> +4"]);
  });

  test("omits stats when the write made no content changes", async () => {
    const { api, renderer } = makeRenderer();
    renderer.handleEvent(toolStart("write", { path: "src/bar.ts" }, "w-2"));
    renderer.handleEvent(toolEndWithDiff("write", undefined, "w-2"));
    await renderer.finish("", "ok");
    expect(api.sent.map((m) => m.text)).toEqual(["✏️ <code>bar.ts</code>"]);
  });
});

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
        "First item is in progress. Now let me finish it and start the next one:",
        "📋 <b>Remember to get water</b>",
      ].join("<br><br>"),
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
