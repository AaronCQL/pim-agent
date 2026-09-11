import type { Api, Context, Filter } from "grammy";
import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";

import { Updater } from "#core/shared/Updater";
import { BOT_COMMANDS, Commands } from "./Commands";
import { THINKING_LEVELS, type TelegramConfig } from "./Config";
import type { Session, SessionId } from "./Session";
import type { SessionRegistry } from "./SessionRegistry";

const quietLog = spyOn(console, "log").mockImplementation(() => {});
const quietWarn = spyOn(console, "warn").mockImplementation(() => {});
const quietError = spyOn(console, "error").mockImplementation(() => {});

afterAll(() => {
  quietLog.mockRestore();
  quietWarn.mockRestore();
  quietError.mockRestore();
});

const config: TelegramConfig = {
  token: "token",
  allow: [],
  cwd: "/repo",
  configDir: "/config",
};

type Sent = {
  readonly chatId: number;
  readonly text: string;
  readonly options: Record<string, unknown>;
};

type Edited = {
  readonly chatId: number;
  readonly messageId: number;
  readonly text: string;
  readonly options: Record<string, unknown>;
};

type Button = { readonly text: string; readonly callback_data: string };

class FakeApi {
  public readonly sent: Sent[] = [];
  public readonly edited: Edited[] = [];
  public readonly actions: unknown[] = [];
  public readonly registered: unknown[] = [];
  public readonly deleted: unknown[] = [];
  public readonly trace: string[] = [];
  public chatType = "private";
  public resolved: readonly { readonly command: string }[] = BOT_COMMANDS;

  public async sendMessage(
    chatId: number,
    text: string,
    options: Record<string, unknown>
  ): Promise<{ readonly message_id: number }> {
    this.trace.push(`sendMessage:${text}`);
    this.sent.push({ chatId, text, options });
    return { message_id: 500 + this.sent.length };
  }

  public async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    options: Record<string, unknown>
  ): Promise<void> {
    this.trace.push(`editMessageText:${text}`);
    this.edited.push({ chatId, messageId, text, options });
  }

  public async sendChatAction(
    chatId: number,
    action: string,
    options: unknown
  ): Promise<void> {
    this.actions.push({ chatId, action, options });
  }

  public async setMyCommands(
    commands: unknown,
    options: unknown
  ): Promise<void> {
    this.registered.push({ commands, options });
  }

  public async deleteMyCommands(options: unknown): Promise<void> {
    this.deleted.push(options);
  }

  public async getChat(chatId: number): Promise<{ readonly type: string }> {
    this.trace.push(`getChat:${chatId}`);
    return { type: this.chatType };
  }

  public async getMyCommands(): Promise<
    readonly { readonly command: string }[]
  > {
    return this.resolved;
  }
}

type Usage = {
  readonly tokens: number | null;
  readonly contextWindow: number;
  readonly percent: number | null;
};

type SessionStub = {
  id: SessionId;
  isStreaming: boolean;
  settings: Record<string, unknown>;
  temporary: boolean;
  currentModelId: string | undefined;
  currentThinkingLevel: string;
  supportedThinkingLevels: readonly string[];
  usage: () => Usage | undefined;
  sessionCost: () => number | undefined;
  cancel: () => Promise<boolean>;
  clear: () => Promise<void>;
  compact: (custom?: string) => Promise<unknown>;
  setCwd: (cwd: string) => Promise<unknown>;
  setModel: (pattern: string) => Promise<unknown>;
  setThinkingLevel: (level: string) => Promise<void>;
  setLogsMode: (mode: string) => Promise<void>;
  setTemporary: (value: boolean) => Promise<void>;
};

function fakeSession(overrides: Partial<SessionStub> = {}): SessionStub {
  return {
    id: { chatId: 1, threadId: undefined },
    isStreaming: false,
    settings: { cwd: "/repo" },
    temporary: false,
    currentModelId: "gpt-5",
    currentThinkingLevel: "medium",
    supportedThinkingLevels: THINKING_LEVELS,
    usage: () => undefined,
    sessionCost: () => undefined,
    cancel: async () => true,
    clear: async () => {},
    compact: async () => ({
      compaction: { tokensBefore: 123456 },
      activeMessages: 7,
    }),
    setCwd: async () => ({ ok: true }),
    setModel: async () => ({ ok: true, id: "openai/gpt-5" }),
    setThinkingLevel: async () => {},
    setLogsMode: async () => {},
    setTemporary: async () => {},
    ...overrides,
  };
}

type Harness = {
  readonly commands: Commands;
  readonly api: FakeApi;
  readonly asked: SessionId[];
};

function build(session: SessionStub): Harness {
  const api = new FakeApi();
  const asked: SessionId[] = [];
  const registry = {
    get: (id: SessionId) => {
      asked.push(id);
      return session as unknown as Session;
    },
  } as unknown as SessionRegistry;
  return {
    commands: new Commands(config, api as unknown as Api, registry),
    api,
    asked,
  };
}

function messageCtx(): {
  readonly ctx: Filter<Context, "message">;
  readonly reacts: unknown[];
} {
  const reacts: unknown[] = [];
  const ctx = {
    react: async (reaction: unknown) => {
      reacts.push(reaction);
    },
  } as unknown as Filter<Context, "message">;
  return { ctx, reacts };
}

function callbackCtx(
  data: string,
  original = "the picker"
): {
  readonly ctx: Filter<Context, "callback_query:data">;
  readonly answered: unknown[];
  readonly edits: { readonly text: string; readonly options: unknown }[];
} {
  const answered: unknown[] = [];
  const edits: { readonly text: string; readonly options: unknown }[] = [];
  const ctx = {
    callbackQuery: { data, message: { text: original } },
    answerCallbackQuery: async (options?: unknown) => {
      answered.push(options);
    },
    editMessageText: async (text: string, options: unknown) => {
      edits.push({ text, options });
    },
  } as unknown as Filter<Context, "callback_query:data">;
  return { ctx, answered, edits };
}

function keyboard(options: Record<string, unknown>): readonly Button[][] {
  return (options.reply_markup as { readonly inline_keyboard: Button[][] })
    .inline_keyboard;
}

async function run(session: SessionStub, raw: string): Promise<Harness> {
  const harness = build(session);
  await harness.commands.handleCommand(
    messageCtx().ctx,
    session as unknown as Session,
    raw
  );
  return harness;
}

beforeEach(() => {
  quietLog.mockClear();
  quietWarn.mockClear();
  quietError.mockClear();
});

test("/chatid names the chat, and the thread when there is one", async () => {
  const plain = await run(fakeSession(), "/chatid");
  expect(plain.api.sent).toEqual([
    {
      chatId: 1,
      text: "Chat ID: <code>1</code>",
      options: {
        parse_mode: "HTML",
        message_thread_id: undefined,
        link_preview_options: { is_disabled: true },
        reply_markup: undefined,
      },
    },
  ]);

  const threaded = await run(
    fakeSession({ id: { chatId: -100, threadId: 42 } }),
    "/chatid"
  );
  expect(threaded.api.sent[0]?.text).toBe(
    "Chat ID: <code>-100</code>\nThread ID: <code>42</code>"
  );
  expect(threaded.api.sent[0]?.options.message_thread_id).toBe(42);
  expect(threaded.api.sent[0]?.options.parse_mode).toBe("HTML");
  expect(threaded.api.sent[0]?.options.link_preview_options).toEqual({
    is_disabled: true,
  });
});

test("/cancel reports both outcomes as plain text", async () => {
  const stopped = await run(
    fakeSession({ cancel: async () => true }),
    "/cancel"
  );
  expect(stopped.api.sent).toEqual([
    {
      chatId: 1,
      text: "❌ Cancelled.",
      options: {
        message_thread_id: undefined,
        link_preview_options: { is_disabled: true },
        reply_markup: undefined,
      },
    },
  ]);
  expect(stopped.api.sent[0]?.options.parse_mode).toBeUndefined();

  const nothing = await run(
    fakeSession({ cancel: async () => false }),
    "/cancel"
  );
  expect(nothing.api.sent[0]?.text).toBe("Nothing to cancel.");
  expect(nothing.api.sent[0]?.options.parse_mode).toBeUndefined();
});

test("an unknown name is echoed back stripped of the bot handle", async () => {
  const unknown = await run(fakeSession(), "/nope");
  expect(unknown.api.sent[0]?.text).toBe("Unknown command: /nope");

  const handled = await run(fakeSession(), "/nope@mybot");
  expect(handled.api.sent[0]?.text).toBe("Unknown command: /nope");

  const asked: string[] = [];
  await run(
    fakeSession({
      setModel: async (pattern) => {
        asked.push(pattern);
        return { ok: true, id: "openai/gpt-5" };
      },
    }),
    "/model@mybot gpt"
  );
  expect(asked).toEqual(["gpt"]);
});

test("the tokenizer collapses whitespace inside the arguments", async () => {
  const seen: (string | undefined)[] = [];
  await run(
    fakeSession({
      compact: async (custom) => {
        seen.push(custom);
        return { compaction: { tokensBefore: 1 }, activeMessages: 1 };
      },
    }),
    "  /compact  keep   the   plan  "
  );
  expect(seen).toEqual(["keep the plan"]);

  const bare: (string | undefined)[] = [];
  await run(
    fakeSession({
      compact: async (custom) => {
        bare.push(custom);
        return { compaction: { tokensBefore: 1 }, activeMessages: 1 };
      },
    }),
    "/compact"
  );
  expect(bare).toEqual([undefined]);
});

test("a queued failure and a direct failure read differently", async () => {
  const direct = await run(
    fakeSession({
      usage: () => {
        throw new Error("boom");
      },
    }),
    "/usage"
  );
  expect(direct.api.sent).toHaveLength(1);
  expect(direct.api.sent[0]?.text).toBe("⚠️ /usage failed: boom");

  const queued = await run(
    fakeSession({
      setCwd: async () => {
        throw new Error("boom");
      },
    }),
    "/cd elsewhere"
  );
  expect(queued.api.sent).toHaveLength(1);
  expect(queued.api.sent[0]?.text).toBe("⚠️ boom");
});

test("a queued command marks a busy turn with 👀 and takes it back", async () => {
  const busySession = fakeSession({ isStreaming: true });
  const busy = build(busySession);
  const watching = messageCtx();
  await busy.commands.handleCommand(
    watching.ctx,
    busySession as unknown as Session,
    "/clear"
  );
  expect(watching.reacts).toEqual(["👀", []]);

  const idleSession = fakeSession();
  const idle = build(idleSession);
  const quiet = messageCtx();
  await idle.commands.handleCommand(
    quiet.ctx,
    idleSession as unknown as Session,
    "/clear"
  );
  expect(quiet.reacts).toEqual([]);
  expect(idle.api.sent[0]?.text).toBe(
    "⚠️ Are you sure you want to reset this thread's chat history and context window?"
  );
  expect(keyboard(idle.api.sent[0]!.options)).toEqual([
    [
      { text: "🚫 Cancel", callback_data: "clear-cancel:1-main" },
      { text: "👍 Yes", callback_data: "clear-confirm:1-main" },
    ],
  ]);
});

test("/cd reads without writing, writes what it resolved, and reports refusal", async () => {
  const untouched: string[] = [];
  const read = await run(
    fakeSession({
      setCwd: async (cwd) => {
        untouched.push(cwd);
        return { ok: true };
      },
    }),
    "/cd"
  );
  expect(untouched).toEqual([]);
  expect(read.api.sent[0]?.text).toBe(
    "<b>CWD</b>: <code>/repo</code>\n<b>To Change</b>: <code>/cd &lt;path&gt;</code>"
  );
  expect(read.api.sent[0]?.options.parse_mode).toBe("HTML");

  const written: string[] = [];
  const write = await run(
    fakeSession({
      setCwd: async (cwd) => {
        written.push(cwd);
        return { ok: true };
      },
    }),
    "/cd packages"
  );
  expect(written).toEqual(["/repo/packages"]);
  expect(write.api.sent[0]?.text).toBe(
    "<b>CWD</b> → <code>/repo/packages</code>"
  );

  const refused = await run(
    fakeSession({ setCwd: async () => ({ ok: false, error: "no such dir" }) }),
    "/cd nowhere"
  );
  expect(refused.api.sent[0]?.text).toBe("⚠️ no such dir");
  expect(refused.api.sent[0]?.options.parse_mode).toBeUndefined();
});

test("/model reads, offers candidates, and says when nothing matches", async () => {
  const read = await run(fakeSession(), "/model");
  expect(read.api.sent[0]?.text).toBe(
    "<b>Model</b>: <code>gpt-5</code>\n<b>To Change</b>: <code>/model &lt;model_name&gt;</code>"
  );

  const unset = await run(fakeSession({ currentModelId: undefined }), "/model");
  expect(unset.api.sent[0]?.text).toStartWith(
    "<b>Model</b>: <code>(unset)</code>"
  );

  const ambiguous = await run(
    fakeSession({
      setModel: async () => ({
        ok: false,
        kind: "ambiguous",
        candidates: ["openai/gpt-5", "openai/gpt-5-mini"],
      }),
    }),
    "/model foo"
  );
  expect(ambiguous.api.sent[0]?.text).toBe(
    '⚠️ Multiple matches for "foo". Please choose one below or use /model with a more specific name.'
  );
  expect(keyboard(ambiguous.api.sent[0]!.options)).toEqual([
    [{ text: "openai/gpt-5", callback_data: "model|openai/gpt-5|1-main" }],
    [
      {
        text: "openai/gpt-5-mini",
        callback_data: "model|openai/gpt-5-mini|1-main",
      },
    ],
    [],
  ]);

  const none = await run(
    fakeSession({
      setModel: async () => ({ ok: false, kind: "none", candidates: ["a/b"] }),
    }),
    "/model zzz"
  );
  expect(none.api.sent[0]?.text).toBe('⚠️ No model matches "zzz". Available:');

  const ok = await run(fakeSession(), "/model gpt");
  expect(ok.api.sent[0]?.text).toBe("<b>Model</b> → <code>openai/gpt-5</code>");
});

test("/compact announces before it works and edits the same message", async () => {
  const order: string[] = [];
  let harness!: Harness;
  const session = fakeSession({
    compact: async () => {
      order.push(`compact after ${harness.api.sent.length} sends`);
      return { compaction: { tokensBefore: 1234567 }, activeMessages: 42 };
    },
  });
  harness = build(session);
  await harness.commands.handleCommand(
    messageCtx().ctx,
    session as unknown as Session,
    "/compact"
  );

  expect(harness.api.sent[0]).toEqual({
    chatId: 1,
    text: "⏳ Compacting context...",
    options: {
      message_thread_id: undefined,
      link_preview_options: { is_disabled: true },
    },
  });
  expect(order).toEqual(["compact after 1 sends"]);
  expect(harness.api.trace).toEqual([
    "sendMessage:⏳ Compacting context...",
    [
      "editMessageText:✅ <b>Context compacted.</b>",
      "",
      "<b>Before</b>: 1,234,567 tokens",
      "<b>Now</b>: 42 messages (exact usage will update after next message)",
    ].join("\n"),
  ]);
  expect(harness.api.actions).toEqual([
    { chatId: 1, action: "typing", options: { message_thread_id: undefined } },
  ]);
  expect(harness.api.edited).toEqual([
    {
      chatId: 1,
      messageId: 501,
      text: [
        "✅ <b>Context compacted.</b>",
        "",
        "<b>Before</b>: 1,234,567 tokens",
        "<b>Now</b>: 42 messages (exact usage will update after next message)",
      ].join("\n"),
      options: {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      },
    },
  ]);

  const failed = await run(
    fakeSession({
      compact: async () => {
        throw new Error("nothing to compact");
      },
    }),
    "/compact"
  );
  expect(failed.api.edited[0]?.text).toBe("⚠️ nothing to compact");
  expect(failed.api.sent).toHaveLength(1);
});

test("/usage formats what the agent knows, and the fallbacks when it does not", async () => {
  const full = await run(
    fakeSession({
      settings: { cwd: "/repo", cumulativeCost: 12.3456 },
      usage: () => ({
        tokens: 1234567,
        contextWindow: 200000,
        percent: 12.34,
      }),
      sessionCost: () => 0.5,
    }),
    "/usage"
  );
  expect(full.api.sent[0]?.text).toBe(
    [
      "<b>Context</b>: <code>1,234,567/200,000 (12.3%)</code>",
      "<b>Session Cost</b>: <code>$0.50</code>",
      "<b>Cumulative Cost</b>: <code>$12.35</code>",
    ].join("\n")
  );

  const unknown = await run(
    fakeSession({
      usage: () => ({
        tokens: null,
        contextWindow: 200000,
        percent: null,
      }),
      sessionCost: () => 0,
    }),
    "/usage"
  );
  expect(unknown.api.sent[0]?.text).toBe(
    [
      "<b>Context</b>: <code>—/200,000 (—)</code>",
      "<b>Session Cost</b>: <code>$0.00</code>",
      "<b>Cumulative Cost</b>: <code>$0.00</code>",
    ].join("\n")
  );

  const noAgent = await run(fakeSession(), "/usage");
  expect(noAgent.api.sent[0]?.text).toBe(
    "<b>Cumulative Cost</b>: <code>$0.00</code>"
  );

  const noUsage = await run(
    fakeSession({
      usage: () => undefined,
      sessionCost: () => 1,
    }),
    "/usage"
  );
  expect(noUsage.api.sent[0]?.text).toBe(
    [
      "<b>Session Cost</b>: <code>$1.00</code>",
      "<b>Cumulative Cost</b>: <code>$0.00</code>",
    ].join("\n")
  );
});

test("/commands registers the table and reports what Telegram resolved", async () => {
  const session = fakeSession();
  const harness = build(session);
  await harness.commands.handleCommand(
    messageCtx().ctx,
    session as unknown as Session,
    "/commands"
  );

  expect(harness.api.registered).toHaveLength(3);
  expect(harness.api.registered[0]).toEqual({
    commands: BOT_COMMANDS,
    options: { scope: { type: "default" } },
  });
  expect(harness.api.deleted).toEqual([
    { scope: { type: "chat", chat_id: 1 } },
    { scope: { type: "chat_administrators", chat_id: 1 } },
  ]);
  expect(harness.api.sent[0]?.text).toBe(
    [
      "✅ <b>Commands registered</b> and chat-scoped overrides cleared:",
      "",
      ...BOT_COMMANDS.map(
        (c) => `✅ <code>/${c.command}</code> — ${c.description}`
      ),
    ].join("\n")
  );
});

test("every registered command dispatches somewhere other than the unknown path", async () => {
  const update = spyOn(Updater, "run").mockResolvedValue({
    ok: false,
    error: "not now",
  } as Awaited<ReturnType<typeof Updater.run>>);
  try {
    for (const { command } of BOT_COMMANDS) {
      const harness = await run(fakeSession(), `/${command}`);
      const texts = [
        ...harness.api.sent.map((one) => one.text),
        ...harness.api.edited.map((one) => one.text),
      ];
      expect(texts.length).toBeGreaterThan(0);
      expect(texts).not.toContain(`Unknown command: /${command}`);
    }
  } finally {
    update.mockRestore();
  }
});

test("/effort draws the levels three to a row and ticks the current one", async () => {
  const harness = await run(fakeSession(), "/effort");
  expect(harness.api.sent[0]?.text).toBe("<b>Effort</b>: <code>medium</code>");
  expect(keyboard(harness.api.sent[0]!.options)).toEqual([
    [
      { text: "off", callback_data: "effort:off:1-main" },
      { text: "minimal", callback_data: "effort:minimal:1-main" },
      { text: "low", callback_data: "effort:low:1-main" },
    ],
    [
      { text: "✅ medium", callback_data: "effort:medium:1-main" },
      { text: "high", callback_data: "effort:high:1-main" },
      { text: "xhigh", callback_data: "effort:xhigh:1-main" },
    ],
  ]);

  const fixed = await run(
    fakeSession({ supportedThinkingLevels: ["off"] }),
    "/effort"
  );
  expect(fixed.api.sent).toEqual([
    {
      chatId: 1,
      text: "Effort level for the current model cannot be configured.",
      options: {
        message_thread_id: undefined,
        link_preview_options: { is_disabled: true },
        reply_markup: undefined,
      },
    },
  ]);
});

test("/logs draws two to a row under a Level header and lists every mode", async () => {
  const harness = await run(fakeSession(), "/logs");
  expect(harness.api.sent[0]?.text).toBe(
    [
      "<b>Level</b>: <code>text</code>",
      "",
      "<b>Options</b>:",
      "• <code>off</code>: final message only",
      "• <code>tool</code>: show tool use",
      "• <code>text</code>: show tool use, and intermediate texts",
      "• <code>verbose</code>: show tool use, intermediate texts, and thinking",
    ].join("\n")
  );
  expect(keyboard(harness.api.sent[0]!.options)).toEqual([
    [
      { text: "off", callback_data: "logs:off:1-main" },
      { text: "tool", callback_data: "logs:tool:1-main" },
    ],
    [
      { text: "✅ text", callback_data: "logs:text:1-main" },
      { text: "verbose", callback_data: "logs:verbose:1-main" },
    ],
  ]);

  const stored = await run(
    fakeSession({ settings: { cwd: "/repo", logsMode: "verbose" } }),
    "/logs"
  );
  expect(stored.api.sent[0]?.text).toStartWith(
    "<b>Level</b>: <code>verbose</code>"
  );
});

test("/temporary is one row of two with the explainer under it", async () => {
  const off = await run(fakeSession(), "/temporary");
  expect(off.api.sent[0]?.text).toBe(
    [
      "<b>Temporary</b>: <code>off</code>",
      "",
      "When <b>on</b>, every message is independent and runs in a fresh session without any chat history.",
    ].join("\n")
  );
  expect(keyboard(off.api.sent[0]!.options)).toEqual([
    [
      { text: "✅ off", callback_data: "temporary:0:1-main" },
      { text: "on", callback_data: "temporary:1:1-main" },
    ],
  ]);

  const on = await run(fakeSession({ temporary: true }), "/temporary");
  expect(on.api.sent[0]?.text).toStartWith("<b>Temporary</b>: <code>on</code>");
  expect(keyboard(on.api.sent[0]!.options)).toEqual([
    [
      { text: "off", callback_data: "temporary:0:1-main" },
      { text: "✅ on", callback_data: "temporary:1:1-main" },
    ],
  ]);
});

test("a picker callback applies the value, toasts it, and moves the tick", async () => {
  const levels: string[] = [];
  const effort = build(
    fakeSession({
      setThinkingLevel: async (level) => {
        levels.push(level);
      },
      currentThinkingLevel: "medium",
    })
  );
  const effortCall = callbackCtx("effort:high:1-main");
  await effort.commands.handleCallback(effortCall.ctx);
  expect(effort.asked).toEqual([{ chatId: 1, threadId: undefined }]);
  expect(levels).toEqual(["high"]);
  expect(effortCall.answered).toEqual([{ text: "Effort: high" }]);
  expect(effortCall.edits[0]?.text).toBe("<b>Effort</b>: <code>high</code>");
  expect(
    keyboard(effortCall.edits[0]!.options as Record<string, unknown>)[1]
  ).toEqual([
    { text: "medium", callback_data: "effort:medium:1-main" },
    { text: "✅ high", callback_data: "effort:high:1-main" },
    { text: "xhigh", callback_data: "effort:xhigh:1-main" },
  ]);
  expect(
    (effortCall.edits[0]!.options as Record<string, unknown>).parse_mode
  ).toBe("HTML");

  const modes: string[] = [];
  const logs = build(
    fakeSession({
      setLogsMode: async (mode) => {
        modes.push(mode);
      },
    })
  );
  const logsCall = callbackCtx("logs:verbose:1-main");
  await logs.commands.handleCallback(logsCall.ctx);
  expect(modes).toEqual(["verbose"]);
  expect(logsCall.answered).toEqual([{ text: "Logs: verbose" }]);
  expect(logsCall.edits[0]?.text).toStartWith(
    "<b>Level</b>: <code>verbose</code>"
  );

  const flags: boolean[] = [];
  const temporary = build(
    fakeSession({
      setTemporary: async (value) => {
        flags.push(value);
      },
    })
  );
  const onCall = callbackCtx("temporary:1:1-main");
  await temporary.commands.handleCallback(onCall.ctx);
  expect(flags).toEqual([true]);
  expect(onCall.answered).toEqual([{ text: "Temporary: on" }]);
  expect(keyboard(onCall.edits[0]!.options as Record<string, unknown>)).toEqual(
    [
      [
        { text: "off", callback_data: "temporary:0:1-main" },
        { text: "✅ on", callback_data: "temporary:1:1-main" },
      ],
    ]
  );

  const offCall = callbackCtx("temporary:0:1-main");
  await temporary.commands.handleCallback(offCall.ctx);
  expect(flags).toEqual([true, false]);
  expect(offCall.answered).toEqual([{ text: "Temporary: off" }]);
});

test("a malformed picker callback is acknowledged and nothing else", async () => {
  const touched: unknown[] = [];
  const session = fakeSession({
    setThinkingLevel: async (level) => {
      touched.push(level);
    },
    setLogsMode: async (mode) => {
      touched.push(mode);
    },
    setTemporary: async (value) => {
      touched.push(value);
    },
  });

  for (const data of [
    "effort:bogus:1-main",
    "effort",
    "effort:",
    "logs:loud:1-main",
    "temporary:2:1-main",
    "nonsense",
  ]) {
    const harness = build(session);
    const call = callbackCtx(data);
    await harness.commands.handleCallback(call.ctx);
    expect(call.answered).toEqual([undefined]);
    expect(call.edits).toEqual([]);
    expect(harness.asked).toEqual([]);
  }
  expect(touched).toEqual([]);
});
