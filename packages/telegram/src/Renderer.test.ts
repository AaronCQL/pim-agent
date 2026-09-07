import { afterAll, describe, expect, spyOn, test } from "bun:test";
import type {
  AgentSessionEvent,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { Api } from "grammy";

import applyPatchExtension from "#core/extensions/apply-patch/index";
import editExtension from "#core/extensions/edit/index";
import subagentExtension from "#core/extensions/subagent/index";
import todoExtension from "#core/extensions/todo/index";
import writeExtension from "#core/extensions/write/index";
import { Tools } from "#core/shared/Tools";
import { Renderer } from "./Renderer";
import type { Session } from "./Session";
import { TaskTool } from "./TaskTool";

// The renderer paints whatever view a tool registered, so the tests register
// the real ones the same way a session does: by loading the extensions.
const fakePi = {
  registerTool: () => {},
  on: () => {},
  getActiveTools: () => [],
  getAllTools: () => [],
} as unknown as ExtensionAPI;

for (const extension of [
  applyPatchExtension,
  editExtension,
  subagentExtension,
  todoExtension,
  writeExtension,
]) {
  extension(fakePi);
}
Tools.wrap(TaskTool.build({} as never));

// Every delivered message logs a line, which is the daemon's journal and this
// suite's noise: a hundred `[send] ... ok` lines around the one failure that
// matters. Silenced here rather than in `Renderer`, so the log stays real.
const sendLog = spyOn(console, "log").mockImplementation(() => {});
afterAll(() => {
  sendLog.mockRestore();
});

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
  cwd: "/repo",
} as unknown as Session;

function makeRenderer(logsMode = "text"): {
  readonly api: FakeApi;
  readonly renderer: Renderer;
} {
  const api = new FakeApi();
  const rendererSession = {
    ...session,
    settings: { logsMode },
  } as unknown as Session;
  return {
    api,
    renderer: new Renderer(rendererSession, api as unknown as Api),
  };
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

  test("labels a delete with the trash emoji once the entries land", async () => {
    const { api, renderer } = makeRenderer();
    renderer.handleEvent(
      applyPatchStart({
        input: "*** Begin Patch\n*** Delete File: src/old.ts\n*** End Patch",
      })
    );
    renderer.handleEvent(
      applyPatchEnd([{ action: { kind: "delete", path: "src/old.ts" } }])
    );
    await renderer.finish("", "ok");
    expect(api.sent.map((m) => m.text)).toEqual(["🗑️ <code>old.ts</code>"]);
  });

  // Before the result lands there are no entries to describe, so the row shows
  // the patch's first path under the tool's own icon.
  test("names the first patched file while the patch is still running", async () => {
    const { api, renderer } = makeRenderer();
    renderer.handleEvent(
      applyPatchStart({
        input: "*** Begin Patch\n*** Delete File: src/old.ts\n*** End Patch",
      })
    );
    await renderer.finish("", "ok");
    expect(api.sent.map((m) => m.text)).toEqual(["✏️ <code>old.ts</code>"]);
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
      "✏️ src/{<s>a.ts</s> ➝ b.ts} +1/-1",
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
    renderer.handleEvent(
      applyPatchEnd([
        {
          action: { kind: "update", path: "src/config.ts" },
          diff: fakeDiff(1, 1),
        },
        { action: { kind: "delete", path: "src/legacy.ts" } },
        { action: { kind: "move", path: "src/a.ts", movePath: "src/b.ts" } },
      ])
    );
    await renderer.finish("", "ok");
    expect(api.sent.map((m) => m.text)).toEqual([
      [
        "✏️ <code>config.ts</code> +1/-1",
        "🗑️ <code>legacy.ts</code>",
        "✏️ src/{<s>a.ts</s> ➝ b.ts}",
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
    expect(api.sent.map((m) => m.text)).toEqual(["✏️ <code>old.ts</code>"]);
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
  test("renders the latest in-progress todo in bold under the tally", async () => {
    const { api, renderer } = makeRenderer();

    renderer.handleEvent(
      todoStart([
        { content: "First task", status: "in_progress" },
        { content: "Second <task> & verify", status: "in_progress" },
      ])
    );
    await renderer.finish("", "ok");

    expect(api.sent.map((msg) => msg.text)).toEqual([
      "📋 2 pending<br>📋 <b>Second &lt;task&gt; &amp; verify</b>",
    ]);
  });

  test("breaks between a todo header and an adjacent tool entry", async () => {
    const { api, renderer } = makeRenderer();

    renderer.handleEvent(
      todoStart([{ content: "Do X", status: "in_progress" }])
    );
    renderer.handleEvent(toolStart("task", { action: "list" }, "task-1"));
    await renderer.finish("", "ok");

    expect(api.sent.map((msg) => msg.text)).toEqual([
      "📋 1 pending<br>📋 <b>Do X</b><br>⏰ List tasks",
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
      "📋 1 pending<br>📋 <b>Remember to buy milk</b> 🟡",
    ]);
    expect(api.edited.map((msg) => msg.text)).toEqual([
      [
        "📋 1 pending<br>📋 <b>Remember to buy milk</b>",
        "<p>First item is in progress. Now let me finish it and start the next one:</p>",
        "📋 1 done, 1 pending<br>📋 <b>Remember to get water</b>",
      ].join(""),
    ]);
  });

  test("shows only the tally for a todo call with nothing in progress", async () => {
    const { api, renderer } = makeRenderer();

    renderer.handleEvent(
      todoStart([
        { content: "Plan", status: "pending" },
        { content: "Done", status: "completed" },
      ])
    );
    await renderer.finish("", "ok");

    expect(api.sent.map((msg) => msg.text)).toEqual(["📋 1 done, 1 pending"]);
  });

  test("ignores malformed todo args", async () => {
    const { api, renderer } = makeRenderer();

    expect(() =>
      renderer.handleEvent(todoStartWithArgs({ text: "done" }))
    ).not.toThrow();
    await renderer.finish("", "ok");

    expect(api.sent.map((msg) => msg.text)).toEqual(["📋 cleared"]);
  });

  test("drops the in-progress line once the item completes", async () => {
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
      "📋 1 pending<br>📋 <b>Build feature</b> 🟡",
    ]);
    expect(api.edited).toEqual([]);
  });
});

describe("Telegram Renderer subagent status", () => {
  test("appends the subagent's progress line to its prompt", async () => {
    const { api, renderer } = makeRenderer();

    renderer.handleEvent(
      toolStart("subagent", { prompt: "review the diff" }, "sa-1")
    );
    renderer.handleEvent({
      type: "tool_execution_update",
      toolCallId: "sa-1",
      toolName: "subagent",
      partialResult: {
        content: [],
        details: {
          entries: [
            { kind: "tool", callId: "t1", name: "read", isError: false },
            { kind: "tool", callId: "t2", name: "read", isError: false },
          ],
          usage: { cost: 0.01, turns: 1 },
          activeToolNames: ["grep"],
        },
      },
    } as AgentSessionEvent);
    await renderer.finish("", "ok");

    expect(api.sent.map((msg) => msg.text)).toEqual([
      "🤖 review the diff read ×2 ⬝ 1 turn ⬝ $0.01 ⬝ grep…",
    ]);
  });

  // pi replaces a failed tool result with `createErrorToolResult`, whose
  // `details` is an empty object; the label update must not choke on it.
  test("ignores a failed subagent result with empty details", async () => {
    const { renderer } = makeRenderer();

    renderer.handleEvent(
      toolStart("subagent", { prompt: "do the thing" }, "sa-2")
    );
    expect(() =>
      renderer.handleEvent({
        type: "tool_execution_end",
        toolCallId: "sa-2",
        toolName: "subagent",
        result: { content: [{ type: "text", text: "boom" }], details: {} },
        isError: true,
      } as AgentSessionEvent)
    ).not.toThrow();
    await renderer.finish("", "ok");
  });
});

describe("Telegram Renderer status length", () => {
  test("keeps long narration entries within the rich-message budget", async () => {
    const { api, renderer } = makeRenderer();
    const long = "x".repeat(1_200);

    for (const event of assistantText(long)) {
      renderer.handleEvent(event);
    }
    await renderer.finish("", "ok");

    expect(api.sent.map((msg) => msg.text)).toEqual([`<p>${long}</p>`]);
  });

  test("renders narration status text as markdown", async () => {
    const { api, renderer } = makeRenderer();

    for (const event of assistantText("**bold** and `code`")) {
      renderer.handleEvent(event);
    }
    await renderer.finish("", "ok");

    expect(api.sent.map((msg) => msg.text)).toEqual([
      "<p><b>bold</b> and <code>code</code></p>",
    ]);
  });

  test("renders verbose thinking status text as markdown", async () => {
    const { api, renderer } = makeRenderer("verbose");

    renderer.handleEvent({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "- **plan**" },
    } as AgentSessionEvent);
    renderer.handleEvent({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end" },
    } as AgentSessionEvent);
    await renderer.finish("", "ok");

    expect(api.sent.map((msg) => msg.text)).toEqual([
      "<ul><li><i><b>plan</b></i></li></ul>",
    ]);
  });

  test("uses no explicit break between thinking and narration blocks", async () => {
    const { api, renderer } = makeRenderer("verbose");

    renderer.handleEvent({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "plan" },
    } as AgentSessionEvent);
    renderer.handleEvent({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end" },
    } as AgentSessionEvent);
    for (const event of assistantText("answer")) {
      renderer.handleEvent(event);
    }
    await renderer.finish("", "ok");

    expect(api.sent.map((msg) => msg.text)).toEqual([
      "<p><i>plan</i></p><p>answer</p>",
    ]);
  });

  test("still caps a single overlong status update", async () => {
    const { api, renderer } = makeRenderer();
    const suffix = " final tail";

    for (const event of assistantText(`start ${"x".repeat(40_000)}${suffix}`)) {
      renderer.handleEvent(event);
    }
    await renderer.finish("", "ok");

    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]!.text.length).toBeLessThanOrEqual(32_000);
    expect(api.sent[0]!.text.startsWith("<p>start xxxxxx")).toBe(true);
    expect(api.sent[0]!.text.endsWith(`xxx…</p>`)).toBe(true);
    expect(api.sent[0]!.text.includes(suffix)).toBe(false);
  });

  test("caps long prose by dropping earlier html blocks", async () => {
    const { api, renderer } = makeRenderer();
    const paragraphs = Array.from(
      { length: 4 },
      (_, i) => `paragraph ${i} ${"x".repeat(9_500)}`
    );

    for (const event of assistantText(paragraphs.join("\n\n"))) {
      renderer.handleEvent(event);
    }
    await renderer.finish("", "ok");

    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]!.text.length).toBeLessThanOrEqual(32_000);
    expect(api.sent[0]!.text.startsWith("<p>… 1 earlier entries</p>")).toBe(
      true
    );
    expect(api.sent[0]!.text).not.toContain("paragraph 0");
    expect(api.sent[0]!.text).toContain("<p>paragraph 1");
    expect(api.sent[0]!.text).toContain("<p>paragraph 3");
  });
});
