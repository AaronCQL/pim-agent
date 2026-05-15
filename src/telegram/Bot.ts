import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  Context,
  type Filter,
  Bot as Grammy,
  GrammyError,
  InlineKeyboard,
} from "grammy";

import { Paths } from "../shared/Paths";
import { Attachment, type AttachmentPrompt } from "./Attachment";
import {
  LOGS_MODES,
  THINKING_LEVELS,
  type LogsMode,
  type TelegramConfig,
  type ThinkingLevelOpt,
} from "./Config";
import { Markdown } from "./Markdown";
import { Renderer, type TurnEndState } from "./Renderer";
import { Session, type SessionId } from "./Session";
import { SessionRegistry } from "./SessionRegistry";
import { Supervisor } from "./Supervisor";
import type { ScheduledTask } from "./TaskSchema";
import { TaskScheduler } from "./TaskScheduler";

const CB_CLEAR_CONFIRM = "clear-confirm";
const CB_CLEAR_CANCEL = "clear-cancel";
const CB_EFFORT = "effort";
const CB_LOGS = "logs";
const CB_MODEL = "model";

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

export class Bot {
  private readonly grammy: Grammy;
  private readonly allowSet: ReadonlySet<number>;
  private readonly registry: SessionRegistry;
  private readonly scheduler: TaskScheduler;
  private readonly config: TelegramConfig;

  public constructor(config: TelegramConfig) {
    this.config = config;
    this.grammy = new Grammy(config.token);
    this.allowSet = new Set(config.allow);
    this.scheduler = new TaskScheduler({
      configDir: config.configDir,
      runTask: (task) => this.runScheduledTask(task),
    });
    this.registry = new SessionRegistry(
      config,
      this.grammy.api,
      this.scheduler
    );

    this.grammy.on("callback_query:data", async (ctx) => {
      if (!this.allowSet.has(ctx.chat?.id ?? -1)) {
        return;
      }
      await this.handleCallback(ctx);
    });

    this.grammy.on("message", async (ctx) => {
      const chatId = ctx.chat.id;
      if (!this.allowSet.has(chatId)) {
        console.log(`[recv] reject chatId=${chatId} (not in allow-list)`);
        return;
      }
      const sessionId: SessionId = {
        chatId,
        threadId: ctx.message.message_thread_id,
      };
      let prompt: AttachmentPrompt | undefined;
      try {
        prompt = await Attachment.fromMessage(
          ctx,
          this.config.token,
          this.config.configDir,
          sessionId
        );
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        console.error(`[recv] attachment download failed:`, err);
        await this.sendPlain(sessionId, `⚠️ ${msg}`);
        return;
      }
      if (!prompt) {
        return;
      }
      const preview = prompt.text.slice(0, 120).replace(/\s+/g, " ");
      console.log(
        `[recv] chatId=${chatId} threadId=${sessionId.threadId ?? "main"} ${preview}`
      );

      const session = this.registry.get(sessionId);
      if (prompt.text.startsWith("/") && !prompt.options.images?.length) {
        await this.handleCommand(ctx, session, prompt.text);
        return;
      }

      void session.run((agent) => this.handleTurn(session, agent, prompt));
    });

    this.grammy.catch((err) => {
      console.error("[bot] handler error:", err.error);
    });
  }

  public async start(): Promise<void> {
    await this.registry.init();
    await this.grammy.init();
    await this.processBootUpdateConfirm();
    await this.grammy.api.deleteWebhook({ drop_pending_updates: true });
    const username = this.grammy.botInfo.username;
    console.log(`bot @${username} ready`);
    await this.scheduler.start();
    await this.grammy.start();
  }

  public async stop(): Promise<void> {
    await this.scheduler.stop();
    await this.grammy.stop();
    await this.registry.disposeAll();
  }

  private async runScheduledTask(task: ScheduledTask): Promise<void> {
    const sessionId: SessionId = {
      chatId: task.chatId,
      threadId: task.threadId,
    };
    const prompt: AttachmentPrompt = { text: task.prompt, options: {} };
    const session = this.registry.get(sessionId);
    await session.run(
      (agent) => this.handleTurn(session, agent, prompt),
      task.isolatedSession ? { isolated: true } : undefined
    );
  }

  private async processBootUpdateConfirm(): Promise<void> {
    const entries = await Supervisor.readUpdateConfirm(this.config.configDir);
    if (entries.length === 0) {
      return;
    }
    const version = await Supervisor.readVersion();
    const text = `✅ Pim Agent updated to v${version}!`;
    await Promise.all(
      entries.map((e) =>
        this.grammy.api
          .editMessageText(e.chatId, e.messageId, text, {
            link_preview_options: { is_disabled: true },
          })
          .catch((err) => console.warn(`[update-confirm] edit failed:`, err))
      )
    );
    await Supervisor.clearUpdateConfirm(this.config.configDir);
  }

  private async handleCommand(
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
        case "/update":
          await this.runQueued(ctx, session, () => this.cmdUpdate(session));
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

  private async runQueued(
    ctx: Filter<Context, "message">,
    session: Session,
    work: () => Promise<void>
  ): Promise<void> {
    const wasBusy = session.isStreaming;
    if (wasBusy) {
      await Bot.reactSafe(ctx, "👀");
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
        await Bot.reactSafe(ctx, []);
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
    const current = session.settings.thinkingLevel ?? "medium";
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

  private async cmdUpdate(session: Session): Promise<void> {
    const sent = await this.grammy.api.sendMessage(
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

  private async handleCallback(
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
          await Bot.safeEditMessage(
            ctx,
            `<b>Model</b> → <code>${Markdown.escape(result.id)}</code>`
          );
        } else {
          await Bot.safeEditMessage(
            ctx,
            Bot.strikeOriginal(ctx, `⚠️ model set failed: ${modelId}`)
          );
        }
      } catch (err) {
        console.error(`[bot] model callback failed for ${modelId}:`, err);
        await Bot.safeEditMessage(
          ctx,
          Bot.strikeOriginal(
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
        await Bot.safeEditMessage(
          ctx,
          Bot.strikeOriginal(ctx, "Context window cleared.")
        );
      } catch (err) {
        console.error(`[bot] queued clear failed:`, err);
        await Bot.safeEditMessage(
          ctx,
          Bot.strikeOriginal(ctx, `⚠️ clear failed: ${(err as Error).message}`)
        );
      }
      return;
    }
    if (action === CB_CLEAR_CANCEL) {
      await ctx.answerCallbackQuery({ text: "Cancelled" });
      await Bot.safeEditMessage(ctx, Bot.strikeOriginal(ctx, "Cancelled."));
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
      await Bot.safeEditMessage(ctx, html, kb);
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
      await Bot.safeEditMessage(ctx, html, kb);
      return;
    }
    await ctx.answerCallbackQuery();
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

  private async handleTurn(
    session: Session,
    agent: AgentSession,
    prompt: AttachmentPrompt
  ): Promise<void> {
    const renderer = new Renderer(session, this.grammy.api);
    const unsubscribe = agent.subscribe((event) => renderer.handleEvent(event));
    await renderer.start();
    try {
      await agent.prompt(prompt.text, {
        ...prompt.options,
        source: "rpc",
      });
      const final = Bot.extractFinalResult(agent);
      await renderer.finish(final.text, final.state);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      console.error(`[bot] turn failed:`, err);
      await renderer.finish(`⚠️ ${msg}`, "error");
    } finally {
      unsubscribe();
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
      await this.grammy.api.sendMessage(sessionId.chatId, html, {
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
      await this.grammy.api.sendMessage(sessionId.chatId, body, {
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

  private static extractFinalResult(agent: AgentSession): {
    readonly text: string;
    readonly state: TurnEndState;
  } {
    const messages = agent.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!;
      if (msg.role !== "assistant") {
        continue;
      }
      if (msg.stopReason === "error") {
        return { text: msg.errorMessage ?? "", state: "error" };
      }
      if (msg.stopReason === "aborted") {
        return { text: msg.errorMessage ?? "", state: "cancelled" };
      }
      const parts: string[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push(block.text);
        }
      }
      return { text: parts.join("").trim(), state: "ok" };
    }
    return { text: "", state: "ok" };
  }
}
