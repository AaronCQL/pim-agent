import {
  Context,
  type Filter,
  GrammyError,
  InlineKeyboard,
  type Api,
} from "grammy";

import { Paths } from "../shared/Paths";
import {
  LOGS_MODES,
  THINKING_LEVELS,
  type LogsMode,
  type TelegramConfig,
  type ThinkingLevelOpt,
} from "./Config";
import { Markdown } from "./Markdown";
import { Session, type SessionId } from "./Session";
import { SessionRegistry } from "./SessionRegistry";
import { Supervisor } from "./Supervisor";

const CB_CLEAR_CONFIRM = "clear-confirm";
const CB_CLEAR_CANCEL = "clear-cancel";
const CB_EFFORT = "effort";
const CB_LOGS = "logs";
const CB_MODEL = "model";
const CB_TEMPORARY = "temporary";

type BotCommand = { readonly command: string; readonly description: string };

export const BOT_COMMANDS: readonly BotCommand[] = [
  { command: "chatid", description: "Show this chat's numeric ID" },
  { command: "cancel", description: "Cancel the current turn" },
  { command: "clear", description: "Reset chat history and context window" },
  { command: "cd", description: "Show or change the working directory" },
  { command: "model", description: "Show or change the AI model" },
  { command: "effort", description: "Show or change thinking effort level" },
  { command: "usage", description: "Show context window and session cost" },
  { command: "logs", description: "Show or change log verbosity" },
  {
    command: "temporary",
    description: "Toggle temporary chat (no history, fresh each message)",
  },
  { command: "update", description: "Update the bot to the latest version" },
  { command: "commands", description: "Register all commands with Telegram" },
];

const LOGS_DESCRIPTIONS: Record<LogsMode, string> = {
  off: "final message only",
  tool: "show tool use",
  text: "show tool use, and intermediate texts",
  verbose: "show tool use, intermediate texts, and thinking",
};

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
    try {
      switch (name) {
        case "/chatid":
          await this.cmdChatId(session);
          return;
        case "/cancel":
          await this.cmdCancel(session);
          return;
        case "/clear":
          await this.runQueued(ctx, session, () => this.cmdClear(session));
          return;
        case "/cd":
          if (!args) {
            await this.cmdCdRead(session);
            return;
          }
          await this.runQueued(ctx, session, () =>
            this.cmdCdWrite(session, args)
          );
          return;
        case "/model":
          if (!args) {
            await this.cmdModelRead(session);
            return;
          }
          await this.runQueued(ctx, session, () =>
            this.cmdModelWrite(session, args)
          );
          return;
        case "/effort":
          await this.cmdEffort(session);
          return;
        case "/usage":
          await this.cmdUsage(session);
          return;
        case "/logs":
          await this.cmdLogs(session);
          return;
        case "/temporary":
          await this.cmdTemporary(session);
          return;
        case "/update":
          await this.runQueued(ctx, session, () => this.cmdUpdate(session));
          return;
        case "/commands":
          await this.cmdCommands(session);
          return;
        default:
          await this.sendPlain(session.id, `Unknown command: ${name}`);
      }
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
      const session = this.registry.get(Session.decodeId(keyPart));
      await ctx.answerCallbackQuery({ text: `Model: ${modelId}` });
      try {
        const result = await session.setModel(modelId);
        if (result.ok) {
          await Commands.safeEditMessage(
            ctx,
            `<b>Model</b> → <code>${Markdown.escape(result.id)}</code>`
          );
        } else {
          await Commands.safeEditMessage(
            ctx,
            Commands.strikeOriginal(ctx, `⚠️ model set failed: ${modelId}`)
          );
        }
      } catch (err) {
        console.error(`[bot] model callback failed for ${modelId}:`, err);
        await Commands.safeEditMessage(
          ctx,
          Commands.strikeOriginal(
            ctx,
            `⚠️ model set failed: ${(err as Error).message}`
          )
        );
      }
      return;
    }

    const colon = data.indexOf(":");
    const action = colon >= 0 ? data.slice(0, colon) : data;
    const keyPart = colon >= 0 ? data.slice(colon + 1) : "";

    if (action === CB_CLEAR_CONFIRM && keyPart) {
      const session = this.registry.get(Session.decodeId(keyPart));
      const wasBusy = session.isStreaming;
      await ctx.answerCallbackQuery({
        text: wasBusy ? "Queued — clearing after current turn" : "Cleared",
      });
      try {
        await session.clear();
        await Commands.safeEditMessage(
          ctx,
          Commands.strikeOriginal(ctx, "Context window cleared.")
        );
      } catch (err) {
        console.error(`[bot] queued clear failed:`, err);
        await Commands.safeEditMessage(
          ctx,
          Commands.strikeOriginal(
            ctx,
            `⚠️ clear failed: ${(err as Error).message}`
          )
        );
      }
      return;
    }
    if (action === CB_CLEAR_CANCEL) {
      await ctx.answerCallbackQuery({ text: "Cancelled" });
      await Commands.safeEditMessage(
        ctx,
        Commands.strikeOriginal(ctx, "Cancelled.")
      );
      return;
    }
    if (action === CB_EFFORT && keyPart) {
      const parts = splitValueAndKey(keyPart);
      if (!parts || !isMember(THINKING_LEVELS, parts.value)) {
        await ctx.answerCallbackQuery();
        return;
      }
      const session = this.registry.get(Session.decodeId(parts.key));
      await session.setThinkingLevel(parts.value);
      await ctx.answerCallbackQuery({ text: `Effort: ${parts.value}` });
      const { kb, html } = this.buildEffortPicker(
        session.id,
        parts.value,
        session.supportedThinkingLevels
      );
      await Commands.safeEditMessage(ctx, html, kb);
      return;
    }
    if (action === CB_LOGS && keyPart) {
      const parts = splitValueAndKey(keyPart);
      if (!parts || !isMember(LOGS_MODES, parts.value)) {
        await ctx.answerCallbackQuery();
        return;
      }
      const session = this.registry.get(Session.decodeId(parts.key));
      await session.setLogsMode(parts.value);
      await ctx.answerCallbackQuery({ text: `Logs: ${parts.value}` });
      const { kb, html } = this.buildLogsPicker(session.id, parts.value);
      await Commands.safeEditMessage(ctx, html, kb);
      return;
    }
    if (action === CB_TEMPORARY && keyPart) {
      const parts = splitValueAndKey(keyPart);
      if (!parts || (parts.value !== "0" && parts.value !== "1")) {
        await ctx.answerCallbackQuery();
        return;
      }
      const value = parts.value === "1";
      const session = this.registry.get(Session.decodeId(parts.key));
      await session.setTemporary(value);
      await ctx.answerCallbackQuery({
        text: `Temporary: ${value ? "on" : "off"}`,
      });
      const { kb, html } = this.buildTemporaryPicker(session.id, value);
      await Commands.safeEditMessage(ctx, html, kb);
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
      await Commands.reactSafe(ctx, "👀");
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
        await Commands.reactSafe(ctx, []);
      }
    }
  }

  private static async reactSafe(
    ctx: Filter<Context, "message">,
    reaction: "👀" | []
  ): Promise<void> {
    await ctx.react(reaction).catch((err: unknown) => {
      console.warn(`[bot] react failed:`, err);
    });
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
    const key = Session.encodeId(session.id);
    const kb = new InlineKeyboard()
      .text("🚫 Cancel", `${CB_CLEAR_CANCEL}:${key}`)
      .text("👍 Yes", `${CB_CLEAR_CONFIRM}:${key}`);
    await this.sendPlain(
      session.id,
      "⚠️ Are you sure you want to reset this thread's chat history and context window?",
      kb
    );
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
      const key = Session.encodeId(session.id);
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
    const current = session.currentThinkingLevel;
    const { kb, html } = this.buildEffortPicker(session.id, current, supported);
    await this.sendWithFallback(session.id, html, kb);
  }

  private buildEffortPicker(
    sessionId: SessionId,
    currentLevel: ThinkingLevelOpt,
    supported: readonly ThinkingLevelOpt[]
  ): { readonly kb: InlineKeyboard; readonly html: string } {
    const key = Session.encodeId(sessionId);
    const kb = new InlineKeyboard();
    for (const [i, lvl] of supported.entries()) {
      const label = lvl === currentLevel ? `✅ ${lvl}` : lvl;
      kb.text(label, `${CB_EFFORT}:${lvl}:${key}`);
      if ((i + 1) % 3 === 0 && i < supported.length - 1) {
        kb.row();
      }
    }
    const html = `<b>Effort</b>: <code>${Markdown.escape(currentLevel)}</code>`;
    return { kb, html };
  }

  private buildLogsPicker(
    sessionId: SessionId,
    currentMode: LogsMode
  ): { readonly kb: InlineKeyboard; readonly html: string } {
    const key = Session.encodeId(sessionId);
    const kb = new InlineKeyboard();
    const descriptions: string[] = [];
    for (const [i, mode] of LOGS_MODES.entries()) {
      const label = mode === currentMode ? `✅ ${mode}` : mode;
      kb.text(label, `${CB_LOGS}:${mode}:${key}`);
      if ((i + 1) % 2 === 0 && i < LOGS_MODES.length - 1) {
        kb.row();
      }
      descriptions.push(
        `• <code>${Markdown.escape(mode)}</code>: ${Markdown.escape(LOGS_DESCRIPTIONS[mode])}`
      );
    }
    const html = [
      `<b>Level</b>: <code>${Markdown.escape(currentMode)}</code>`,
      "",
      `<b>Options</b>:`,
      ...descriptions,
    ].join("\n");
    return { kb, html };
  }

  private async cmdUsage(session: Session): Promise<void> {
    const lines: string[] = [];
    const agent = session.agentSession;
    if (agent) {
      const usage = agent.getContextUsage();
      const stats = agent.getSessionStats();
      if (usage) {
        const pct =
          usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "—";
        const tok =
          usage.tokens !== null ? usage.tokens.toLocaleString("en-US") : "—";
        const ctx = usage.contextWindow.toLocaleString("en-US");
        lines.push(`<b>Context</b>: <code>${tok}/${ctx} (${pct})</code>`);
      }
      lines.push(
        `<b>Session Cost</b>: <code>$${(stats.cost ?? 0).toFixed(2)}</code>`
      );
    }
    lines.push(
      `<b>Cumulative Cost</b>: <code>$${(session.settings.cumulativeCost ?? 0).toFixed(2)}</code>`
    );
    await this.sendWithFallback(session.id, lines.join("\n"));
  }

  private async cmdLogs(session: Session): Promise<void> {
    const current = session.settings.logsMode ?? "text";
    const { kb, html } = this.buildLogsPicker(session.id, current);
    await this.sendWithFallback(session.id, html, kb);
  }

  private async cmdTemporary(session: Session): Promise<void> {
    const { kb, html } = this.buildTemporaryPicker(
      session.id,
      session.temporary
    );
    await this.sendWithFallback(session.id, html, kb);
  }

  private buildTemporaryPicker(
    sessionId: SessionId,
    current: boolean
  ): { readonly kb: InlineKeyboard; readonly html: string } {
    const key = Session.encodeId(sessionId);
    const kb = new InlineKeyboard()
      .text(current ? "off" : "✅ off", `${CB_TEMPORARY}:0:${key}`)
      .text(current ? "✅ on" : "on", `${CB_TEMPORARY}:1:${key}`);
    const html = [
      `<b>Temporary</b>: <code>${current ? "on" : "off"}</code>`,
      "",
      "When <b>on</b>, every message is independent and runs in a fresh session without any chat history.",
    ].join("\n");
    return { kb, html };
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
    const result = await Supervisor.update();
    if (!result.ok) {
      await this.sendPlain(session.id, `⚠️ ${result.error}`);
      return;
    }

    await Supervisor.appendUpdateConfirm(this.config.configDir, {
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

  private static strikeOriginal(
    ctx: Filter<Context, "callback_query:data">,
    note: string
  ): string {
    const original = ctx.callbackQuery.message?.text ?? "";
    return `<s>${Markdown.escape(original)}</s>\n\n<i>${note}</i>`;
  }

  private static async safeEditMessage(
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
