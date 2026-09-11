import {
  Context,
  type Filter,
  GrammyError,
  InlineKeyboard,
  type Api,
} from "grammy";

import { DaemonUnit } from "#core/shared/DaemonUnit";
import { Paths } from "#core/shared/Paths";
import { Supervisor } from "#core/shared/Supervisor";
import { Updater } from "#core/shared/Updater";
import {
  LOGS_MODES,
  THINKING_LEVELS,
  type LogsMode,
  type TelegramConfig,
} from "./Config";
import { Markdown } from "./Markdown";
import {
  decodeId,
  encodeId,
  Session,
  type SessionCompactResult,
  type SessionId,
} from "./Session";
import { SessionRegistry } from "./SessionRegistry";
import { TypingIndicator } from "./TypingIndicator";
import { UpdateConfirm } from "./UpdateConfirm";

const CB_CLEAR_CONFIRM = "clear-confirm";
const CB_CLEAR_CANCEL = "clear-cancel";
const CB_EFFORT = "effort";
const CB_LOGS = "logs";
const CB_MODEL = "model";
const CB_TEMPORARY = "temporary";

type BotCommand = { readonly command: string; readonly description: string };

type CommandSpec = {
  readonly name: string;
  readonly description: string;
  readonly queued?: (args: string) => boolean;
  readonly run: (
    self: Commands,
    session: Session,
    args: string
  ) => Promise<void>;
};

const LOGS_DESCRIPTIONS: Record<LogsMode, string> = {
  off: "final message only",
  tool: "show tool use",
  text: "show tool use, and intermediate texts",
  verbose: "show tool use, intermediate texts, and thinking",
};

type Picker = {
  readonly action: string;
  readonly title: string;
  readonly header: string;
  readonly columns: number;
  readonly values: (session: Session) => readonly string[];
  readonly label: (value: string) => string;
  readonly current: (session: Session) => string;
  readonly apply: (
    value: string
  ) => ((session: Session) => Promise<void>) | undefined;
  readonly body?: readonly string[];
};

const EFFORT_PICKER: Picker = {
  action: CB_EFFORT,
  title: "Effort",
  header: "Effort",
  columns: 3,
  values: (session) => session.supportedThinkingLevels,
  label: (value) => value,
  current: (session) => session.currentThinkingLevel,
  apply: (value) =>
    isMember(THINKING_LEVELS, value)
      ? (session) => session.setThinkingLevel(value)
      : undefined,
};

const LOGS_PICKER: Picker = {
  action: CB_LOGS,
  title: "Logs",
  header: "Level",
  columns: 2,
  values: () => LOGS_MODES,
  label: (value) => value,
  current: (session) => session.settings.logsMode ?? "text",
  apply: (value) =>
    isMember(LOGS_MODES, value)
      ? (session) => session.setLogsMode(value)
      : undefined,
  body: [
    "",
    `<b>Options</b>:`,
    ...LOGS_MODES.map(
      (mode) =>
        `• <code>${Markdown.escape(mode)}</code>: ${Markdown.escape(LOGS_DESCRIPTIONS[mode])}`
    ),
  ],
};

const TEMPORARY_PICKER: Picker = {
  action: CB_TEMPORARY,
  title: "Temporary",
  header: "Temporary",
  columns: 2,
  values: () => ["0", "1"],
  label: (value) => (value === "1" ? "on" : "off"),
  current: (session) => (session.temporary ? "1" : "0"),
  apply: (value) =>
    value === "0" || value === "1"
      ? (session) => session.setTemporary(value === "1")
      : undefined,
  body: [
    "",
    "When <b>on</b>, every message is independent and runs in a fresh session without any chat history.",
  ],
};

const PICKERS: readonly Picker[] = [
  EFFORT_PICKER,
  LOGS_PICKER,
  TEMPORARY_PICKER,
];

function buildPicker(
  picker: Picker,
  session: Session,
  current: string
): { readonly kb: InlineKeyboard; readonly html: string } {
  const key = encodeId(session.id);
  const kb = new InlineKeyboard();
  const values = picker.values(session);
  for (const [i, value] of values.entries()) {
    const label = picker.label(value);
    kb.text(
      value === current ? `✅ ${label}` : label,
      `${picker.action}:${value}:${key}`
    );
    if ((i + 1) % picker.columns === 0 && i < values.length - 1) {
      kb.row();
    }
  }
  const html = [
    `<b>${picker.header}</b>: <code>${Markdown.escape(picker.label(current))}</code>`,
    ...(picker.body ?? []),
  ].join("\n");
  return { kb, html };
}

function splitValueAndKey(
  s: string
): { readonly value: string; readonly key: string } | undefined {
  const i = s.indexOf(":");
  if (i < 0) {
    return undefined;
  }
  return { value: s.slice(0, i), key: s.slice(i + 1) };
}

function isMember<T extends string>(
  tuple: readonly T[],
  value: string
): value is T {
  return (tuple as readonly string[]).includes(value);
}

export class Commands {
  private readonly config: TelegramConfig;
  private readonly api: Api;
  private readonly registry: SessionRegistry;

  private static readonly COMMANDS: readonly CommandSpec[] = [
    {
      name: "chatid",
      description: "Show this chat's numeric ID",
      run: (self, session) => self.cmdChatId(session),
    },
    {
      name: "cancel",
      description: "Cancel the current turn",
      run: (self, session) => self.cmdCancel(session),
    },
    {
      name: "clear",
      description: "Reset chat history and context window",
      queued: () => true,
      run: (self, session) => self.cmdClear(session),
    },
    {
      name: "compact",
      description: "Compact the current session context",
      queued: () => true,
      run: (self, session, args) => self.cmdCompact(session, args || undefined),
    },
    {
      name: "cd",
      description: "Show or change the working directory",
      queued: (args) => args.length > 0,
      run: (self, session, args) =>
        args ? self.cmdCdWrite(session, args) : self.cmdCdRead(session),
    },
    {
      name: "model",
      description: "Show or change the AI model",
      queued: (args) => args.length > 0,
      run: (self, session, args) =>
        args ? self.cmdModelWrite(session, args) : self.cmdModelRead(session),
    },
    {
      name: "effort",
      description: "Show or change thinking effort level",
      run: (self, session) => self.cmdEffort(session),
    },
    {
      name: "usage",
      description: "Show context window and session cost",
      run: (self, session) => self.cmdUsage(session),
    },
    {
      name: "logs",
      description: "Show or change log verbosity",
      run: (self, session) => self.showPicker(LOGS_PICKER, session),
    },
    {
      name: "temporary",
      description: "Toggle temporary chat (no history, fresh each message)",
      run: (self, session) => self.showPicker(TEMPORARY_PICKER, session),
    },
    {
      name: "update",
      description: "Update the bot to the latest version",
      queued: () => true,
      run: (self, session) => self.cmdUpdate(session),
    },
    {
      name: "commands",
      description: "Register all commands with Telegram",
      run: (self, session) => self.cmdCommands(session),
    },
  ];

  public static botCommands(): readonly BotCommand[] {
    return Commands.COMMANDS.map(({ name, description }) => ({
      command: name,
      description,
    }));
  }

  public constructor(
    config: TelegramConfig,
    api: Api,
    registry: SessionRegistry
  ) {
    this.config = config;
    this.api = api;
    this.registry = registry;
  }

  public async handleCommand(
    ctx: Filter<Context, "message">,
    session: Session,
    raw: string
  ): Promise<void> {
    const [first, ...rest] = raw.trim().split(/\s+/);
    const name = (first ?? "").split("@")[0];
    const args = rest.join(" ").trim();
    const spec = Commands.COMMANDS.find((one) => `/${one.name}` === name);
    try {
      if (!spec) {
        await this.sendPlain(session.id, `Unknown command: ${name}`);
        return;
      }
      if (spec.queued?.(args) === true) {
        await this.runQueued(ctx, session, () => spec.run(this, session, args));
        return;
      }
      await spec.run(this, session, args);
    } catch (err) {
      console.error(`[bot] command ${name} failed:`, err);
      await this.sendPlain(
        session.id,
        `⚠️ ${name} failed: ${(err as Error).message}`
      );
    }
  }

  public async handleCallback(
    ctx: Filter<Context, "callback_query:data">
  ): Promise<void> {
    const data = ctx.callbackQuery.data;

    if (data.startsWith(`${CB_MODEL}|`)) {
      const idx1 = data.indexOf("|");
      const idx2 = data.lastIndexOf("|");
      const modelId = data.slice(idx1 + 1, idx2);
      const keyPart = data.slice(idx2 + 1);
      const session = this.registry.get(decodeId(keyPart));
      await ctx.answerCallbackQuery({ text: `Model: ${modelId}` });
      try {
        const result = await session.setModel(modelId);
        if (result.ok) {
          await safeEditMessage(
            ctx,
            `<b>Model</b> → <code>${Markdown.escape(result.id)}</code>`
          );
        } else {
          await safeEditMessage(
            ctx,
            strikeOriginal(ctx, `⚠️ model set failed: ${modelId}`)
          );
        }
      } catch (err) {
        console.error(`[bot] model callback failed for ${modelId}:`, err);
        await safeEditMessage(
          ctx,
          strikeOriginal(ctx, `⚠️ model set failed: ${(err as Error).message}`)
        );
      }
      return;
    }

    const colon = data.indexOf(":");
    const action = colon >= 0 ? data.slice(0, colon) : data;
    const keyPart = colon >= 0 ? data.slice(colon + 1) : "";

    if (action === CB_CLEAR_CONFIRM && keyPart) {
      const session = this.registry.get(decodeId(keyPart));
      const wasBusy = session.isStreaming;
      await ctx.answerCallbackQuery({
        text: wasBusy ? "Queued — clearing after current turn" : "Cleared",
      });
      try {
        await session.clear();
        await safeEditMessage(
          ctx,
          strikeOriginal(ctx, "Context window cleared.")
        );
      } catch (err) {
        console.error(`[bot] queued clear failed:`, err);
        await safeEditMessage(
          ctx,
          strikeOriginal(ctx, `⚠️ clear failed: ${(err as Error).message}`)
        );
      }
      return;
    }
    if (action === CB_CLEAR_CANCEL) {
      await ctx.answerCallbackQuery({ text: "Cancelled" });
      await safeEditMessage(ctx, strikeOriginal(ctx, "Cancelled."));
      return;
    }
    const picker = PICKERS.find((one) => one.action === action);
    if (picker && keyPart) {
      const parts = splitValueAndKey(keyPart);
      const applyTo = parts && picker.apply(parts.value);
      if (!parts || !applyTo) {
        await ctx.answerCallbackQuery();
        return;
      }
      const session = this.registry.get(decodeId(parts.key));
      await applyTo(session);
      await ctx.answerCallbackQuery({
        text: `${picker.title}: ${picker.label(parts.value)}`,
      });
      const { kb, html } = buildPicker(picker, session, parts.value);
      await safeEditMessage(ctx, html, kb);
      return;
    }
    await ctx.answerCallbackQuery();
  }

  private async runQueued(
    ctx: Filter<Context, "message">,
    session: Session,
    work: () => Promise<void>
  ): Promise<void> {
    const wasBusy = session.isStreaming;
    if (wasBusy) {
      await reactSafe(ctx, "👀");
    }
    try {
      await work();
    } catch (err) {
      console.error(`[bot] queued command failed:`, err);
      await this.sendPlain(
        session.id,
        `⚠️ ${(err as Error).message ?? String(err)}`
      );
    } finally {
      if (wasBusy) {
        await reactSafe(ctx, []);
      }
    }
  }

  private async cmdChatId(session: Session): Promise<void> {
    const lines = [`Chat ID: <code>${session.id.chatId}</code>`];
    if (session.id.threadId) {
      lines.push(`Thread ID: <code>${session.id.threadId}</code>`);
    }
    await this.sendWithFallback(session.id, lines.join("\n"));
  }

  private async cmdCancel(session: Session): Promise<void> {
    const cancelled = await session.cancel();
    await this.sendPlain(
      session.id,
      cancelled ? "❌ Cancelled." : "Nothing to cancel."
    );
  }

  private async cmdClear(session: Session): Promise<void> {
    const key = encodeId(session.id);
    const kb = new InlineKeyboard()
      .text("🚫 Cancel", `${CB_CLEAR_CANCEL}:${key}`)
      .text("👍 Yes", `${CB_CLEAR_CONFIRM}:${key}`);
    await this.sendPlain(
      session.id,
      "⚠️ Are you sure you want to reset this thread's chat history and context window?",
      kb
    );
  }

  private async cmdCompact(
    session: Session,
    customInstructions?: string
  ): Promise<void> {
    const sent = await this.api.sendMessage(
      session.id.chatId,
      "⏳ Compacting context...",
      {
        message_thread_id: session.id.threadId,
        link_preview_options: { is_disabled: true },
      }
    );
    const typing = new TypingIndicator(this.api, session.id);
    typing.start();
    try {
      const result = await session.compact(customInstructions);
      await this.editStatusMessage(
        session.id,
        sent.message_id,
        renderCompactSuccess(result)
      );
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      console.error(`[bot] compact failed:`, err);
      await this.editStatusMessage(
        session.id,
        sent.message_id,
        `⚠️ ${Markdown.escape(msg)}`
      );
    } finally {
      typing.stop();
    }
  }

  private async cmdCdRead(session: Session): Promise<void> {
    const cwd = Paths.abbreviateHome(session.settings.cwd ?? this.config.cwd);
    const lines = [
      `<b>CWD</b>: <code>${Markdown.escape(cwd)}</code>`,
      `<b>To Change</b>: <code>/cd &lt;path&gt;</code>`,
    ];
    await this.sendWithFallback(session.id, lines.join("\n"));
  }

  private async cmdCdWrite(session: Session, args: string): Promise<void> {
    const resolved = Paths.resolve(
      args,
      session.settings.cwd ?? this.config.cwd
    );
    const result = await session.setCwd(resolved);
    if (!result.ok) {
      await this.sendPlain(session.id, `⚠️ ${result.error}`);
      return;
    }
    const html = `<b>CWD</b> → <code>${Markdown.escape(Paths.abbreviateHome(resolved))}</code>`;
    await this.sendWithFallback(session.id, html);
  }

  private async cmdModelRead(session: Session): Promise<void> {
    const current = session.currentModelId ?? "(unset)";
    const html = [
      `<b>Model</b>: <code>${Markdown.escape(current)}</code>`,
      `<b>To Change</b>: <code>/model &lt;model_name&gt;</code>`,
    ].join("\n");
    await this.sendWithFallback(session.id, html);
  }

  private async cmdModelWrite(session: Session, args: string): Promise<void> {
    const result = await session.setModel(args);
    if (!result.ok) {
      const key = encodeId(session.id);
      const kb = new InlineKeyboard();
      for (const c of result.candidates) {
        kb.text(c, `${CB_MODEL}|${c}|${key}`).row();
      }
      const header =
        result.kind === "ambiguous"
          ? `⚠️ Multiple matches for "${Markdown.escape(args)}". Please choose one below or use /model with a more specific name.`
          : `⚠️ No model matches "${Markdown.escape(args)}". Available:`;
      await this.sendWithFallback(session.id, header, kb);
      return;
    }
    await this.sendWithFallback(
      session.id,
      `<b>Model</b> → <code>${Markdown.escape(result.id)}</code>`
    );
  }

  private async cmdEffort(session: Session): Promise<void> {
    const supported = session.supportedThinkingLevels;
    if (supported.length <= 1) {
      await this.sendPlain(
        session.id,
        "Effort level for the current model cannot be configured."
      );
      return;
    }
    await this.showPicker(EFFORT_PICKER, session);
  }

  private async showPicker(picker: Picker, session: Session): Promise<void> {
    const { kb, html } = buildPicker(picker, session, picker.current(session));
    await this.sendWithFallback(session.id, html, kb);
  }

  private async cmdUsage(session: Session): Promise<void> {
    const lines: string[] = [];
    const usage = session.usage();
    if (usage) {
      const pct = usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "—";
      const tok =
        usage.tokens !== null ? usage.tokens.toLocaleString("en-US") : "—";
      const ctx = usage.contextWindow.toLocaleString("en-US");
      lines.push(`<b>Context</b>: <code>${tok}/${ctx} (${pct})</code>`);
    }
    const cost = session.sessionCost();
    if (cost !== undefined) {
      lines.push(`<b>Session Cost</b>: <code>$${cost.toFixed(2)}</code>`);
    }
    lines.push(
      `<b>Cumulative Cost</b>: <code>$${(session.settings.cumulativeCost ?? 0).toFixed(2)}</code>`
    );
    await this.sendWithFallback(session.id, lines.join("\n"));
  }

  private async cmdUpdate(session: Session): Promise<void> {
    const sent = await this.api.sendMessage(
      session.id.chatId,
      "🔄 Updating...",
      {
        message_thread_id: session.id.threadId,
        link_preview_options: { is_disabled: true },
      }
    );
    const progress = async (text: string): Promise<void> => {
      await this.api
        .editMessageText(session.id.chatId, sent.message_id, text, {
          link_preview_options: { is_disabled: true },
        })
        .catch((err: unknown) => console.warn(`[update] edit failed:`, err));
    };
    const outcome = await Updater.run({
      onStep: (label) => progress(`🔄 ${label}...`),
    });
    if (!outcome.ok) {
      await this.sendPlain(session.id, `⚠️ ${outcome.error}`);
      return;
    }

    const moved =
      outcome.to === outcome.from
        ? `Already on v${outcome.to}`
        : `Updated v${outcome.from} → v${outcome.to}`;
    const notes = outcome.skipped.map(
      (s) => `\nSkipped ${s.label}: ${s.reason}.`
    );
    // Restart siblings first; this daemon restarts by exiting, so it must go last.
    await Supervisor.restartSiblings(DaemonUnit);
    if (!Supervisor.isSupervised()) {
      await progress(
        `✅ ${moved}.${notes.join("")}\nNo supervisor is watching this process, so restart it yourself.`
      );
      return;
    }

    await UpdateConfirm.append(this.config.configDir, {
      chatId: session.id.chatId,
      threadId: session.id.threadId,
      messageId: sent.message_id,
    });
    Supervisor.restart();
  }

  private async cmdCommands(session: Session): Promise<void> {
    const chatId = session.id.chatId;
    try {
      const globalScopes = [
        { type: "default" as const },
        { type: "all_private_chats" as const },
        { type: "all_group_chats" as const },
      ];
      await Promise.all(
        globalScopes.map((scope) =>
          this.api.setMyCommands(BOT_COMMANDS, { scope })
        )
      );

      await this.api.deleteMyCommands({
        scope: { type: "chat", chat_id: chatId },
      });
      try {
        await this.api.deleteMyCommands({
          scope: { type: "chat_administrators", chat_id: chatId },
        });
      } catch {
        // chat_administrators scope is only valid for group chats.
      }

      const chat = await this.api.getChat(chatId);
      const resolvedScope =
        chat.type === "private"
          ? ({ type: "all_private_chats" } as const)
          : ({ type: "all_group_chats" } as const);
      const actual = await this.api.getMyCommands({
        scope: resolvedScope,
      });
      const actualMap = new Set(actual.map((c) => c.command));
      const lines = [
        "✅ <b>Commands registered</b> and chat-scoped overrides cleared:",
        "",
        ...BOT_COMMANDS.map((c) => {
          const ok = actualMap.has(c.command) ? "✅" : "❌";
          return `${ok} <code>/${c.command}</code> — ${Markdown.escape(c.description)}`;
        }),
      ];
      if (actual.length !== BOT_COMMANDS.length) {
        lines.push(
          "",
          `⚠️ <b>${BOT_COMMANDS.length}</b> sent but <b>${actual.length}</b> resolved for this chat. Restart Telegram if commands don't show in autocomplete.`
        );
      }
      await this.sendWithFallback(session.id, lines.join("\n"));
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      console.error("[bot] setMyCommands failed:", err);
      await this.sendPlain(
        session.id,
        `⚠️ Failed to register commands: ${Markdown.escape(msg)}`
      );
    }
  }

  private async editStatusMessage(
    sessionId: SessionId,
    messageId: number,
    html: string
  ): Promise<void> {
    try {
      await this.api.editMessageText(sessionId.chatId, messageId, html, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      console.warn(`[send] status edit failed:`, err);
    }
  }

  private async sendWithFallback(
    sessionId: SessionId,
    html: string,
    replyMarkup?: InlineKeyboard
  ): Promise<void> {
    if (!html) {
      return;
    }
    try {
      await this.api.sendMessage(sessionId.chatId, html, {
        parse_mode: "HTML",
        message_thread_id: sessionId.threadId,
        link_preview_options: { is_disabled: true },
        reply_markup: replyMarkup,
      });
      console.log(
        `[send] chatId=${sessionId.chatId} threadId=${sessionId.threadId ?? "main"} html ok (${html.length}b)`
      );
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 400) {
        console.warn(`[send] HTML 400 (${err.description}) — retry plain`);
        await this.sendPlain(sessionId, html, replyMarkup);
        return;
      }
      throw err;
    }
  }

  private async sendPlain(
    sessionId: SessionId,
    body: string,
    replyMarkup?: InlineKeyboard
  ): Promise<void> {
    try {
      await this.api.sendMessage(sessionId.chatId, body, {
        message_thread_id: sessionId.threadId,
        link_preview_options: { is_disabled: true },
        reply_markup: replyMarkup,
      });
      console.log(
        `[send] chatId=${sessionId.chatId} threadId=${sessionId.threadId ?? "main"} plain ok (${body.length}b)`
      );
    } catch (err) {
      console.error(`[send] plain failed:`, err);
    }
  }
}

async function reactSafe(
  ctx: Filter<Context, "message">,
  reaction: "👀" | []
): Promise<void> {
  await ctx.react(reaction).catch((err: unknown) => {
    console.warn(`[bot] react failed:`, err);
  });
}

export const BOT_COMMANDS: readonly BotCommand[] = Commands.botCommands();

function strikeOriginal(
  ctx: Filter<Context, "callback_query:data">,
  note: string
): string {
  const original = ctx.callbackQuery.message?.text ?? "";
  return `<s>${Markdown.escape(original)}</s>\n\n<i>${note}</i>`;
}

function renderCompactSuccess(result: SessionCompactResult): string {
  const before = result.compaction.tokensBefore.toLocaleString("en-US");
  const messages = result.activeMessages.toLocaleString("en-US");
  return [
    "✅ <b>Context compacted.</b>",
    "",
    `<b>Before</b>: ${before} tokens`,
    `<b>Now</b>: ${messages} messages (exact usage will update after next message)`,
  ].join("\n");
}

async function safeEditMessage(
  ctx: Filter<Context, "callback_query:data">,
  html: string,
  replyMarkup?: InlineKeyboard
): Promise<void> {
  try {
    await ctx.editMessageText(html, {
      parse_mode: "HTML",
      reply_markup: replyMarkup,
    });
  } catch {
    // Message may have aged out past Telegram's edit window — non-fatal.
  }
}
