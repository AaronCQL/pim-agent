import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  Context,
  type Filter,
  Bot as Grammy,
  GrammyError,
  InlineKeyboard,
} from "grammy";

import { Paths } from "../shared/Paths";
import {
  LOGS_MODES,
  THINKING_LEVELS,
  type LogsMode,
  type TelegramConfig,
  type ThinkingLevelOpt,
} from "./config";
import {
  buildPromptWithAttachments,
  type AttachmentPrompt,
} from "./files/attachments";
import { escape as escapeMarkdown } from "./markdown";
import { modelId } from "./model";
import { Renderer, type TurnEndState } from "./Renderer";
import { SessionRegistry, type ThreadHandle } from "./SessionRegistry";
import {
  appendUpdateConfirm,
  clearUpdateConfirm,
  readUpdateConfirm,
  runUpdate,
} from "./supervisor";
import { Scheduler } from "./tasks/Scheduler";
import type { ScheduledTask } from "./tasks/schema";

const CB_CLEAR_CONFIRM = "clear-confirm";
const CB_CLEAR_CANCEL = "clear-cancel";
const CB_EFFORT = "effort";
const CB_LOGS = "logs";

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
  private readonly scheduler: Scheduler;
  private readonly config: TelegramConfig;

  public constructor(config: TelegramConfig) {
    this.config = config;
    this.grammy = new Grammy(config.token);
    this.allowSet = new Set(config.allow);
    this.scheduler = new Scheduler({
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
      const handle: ThreadHandle = {
        chatId,
        threadId: ctx.message.message_thread_id,
      };
      let prompt: AttachmentPrompt | undefined;
      try {
        prompt = await buildPromptWithAttachments(
          ctx,
          this.config.token,
          this.config.configDir,
          handle
        );
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        console.error(`[recv] attachment download failed:`, err);
        await this.sendPlain(handle, `⚠️ ${msg}`);
        return;
      }
      if (!prompt) {
        return;
      }
      const preview = prompt.text.slice(0, 120).replace(/\s+/g, " ");
      console.log(
        `[recv] chatId=${chatId} threadId=${handle.threadId ?? "main"} ${preview}`
      );

      if (prompt.text.startsWith("/") && !prompt.options.images?.length) {
        await this.handleCommand(ctx, handle, prompt.text);
        return;
      }

      if (
        await this.registry.steerIfStreaming(
          handle,
          prompt.text,
          prompt.options
        )
      ) {
        return;
      }

      void this.registry.enqueue(handle, (session) =>
        this.handleTurn(handle, session, prompt)
      );
    });

    this.grammy.catch((err) => {
      console.error("[bot] handler error:", err.error);
    });
  }

  public async run(): Promise<void> {
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
    const handle: ThreadHandle = {
      chatId: task.chatId,
      threadId: task.threadId,
    };
    const prompt: AttachmentPrompt = { text: task.prompt, options: {} };
    const work = (session: AgentSession): Promise<void> =>
      this.handleTurn(handle, session, prompt);
    if (task.isolatedSession) {
      await this.registry.enqueueIsolated(handle, work);
    } else {
      await this.registry.enqueue(handle, work);
    }
  }

  private async processBootUpdateConfirm(): Promise<void> {
    const entries = await readUpdateConfirm(this.config.configDir);
    if (entries.length === 0) {
      return;
    }
    await Promise.all(
      entries.map((e) =>
        this.grammy.api
          .sendMessage(e.chatId, `✅ Pim daemon updated.`, {
            message_thread_id: e.threadId,
            link_preview_options: { is_disabled: true },
          })
          .catch((err) => console.warn(`[update-confirm] send failed:`, err))
      )
    );
    await clearUpdateConfirm(this.config.configDir);
  }

  private async handleCommand(
    ctx: Filter<Context, "message">,
    handle: ThreadHandle,
    raw: string
  ): Promise<void> {
    const [first, ...rest] = raw.trim().split(/\s+/);
    const name = (first ?? "").split("@")[0];
    const args = rest.join(" ").trim();
    try {
      switch (name) {
        case "/chatid":
          await this.cmdChatId(handle);
          return;
        case "/cancel":
          await this.cmdCancel(handle);
          return;
        case "/clear":
          await this.runQueued(ctx, handle, () => this.cmdClear(handle));
          return;
        case "/cd":
          if (!args) {
            await this.cmdCdRead(handle);
            return;
          }
          await this.runQueued(ctx, handle, () =>
            this.cmdCdWrite(handle, args)
          );
          return;
        case "/model":
          if (!args) {
            await this.cmdModelRead(handle);
            return;
          }
          await this.runQueued(ctx, handle, () =>
            this.cmdModelWrite(handle, args)
          );
          return;
        case "/effort":
          await this.cmdEffort(handle, args);
          return;
        case "/usage":
          await this.cmdUsage(handle);
          return;
        case "/logs":
          await this.cmdLogs(handle, args);
          return;
        case "/update":
          await this.runQueued(ctx, handle, () => this.cmdUpdate(handle));
          return;
        default:
          await this.sendPlain(handle, `Unknown command: ${name}`);
      }
    } catch (err) {
      console.error(`[bot] command ${name} failed:`, err);
      await this.sendPlain(
        handle,
        `⚠️ ${name} failed: ${(err as Error).message}`
      );
    }
  }

  private async runQueued(
    ctx: Filter<Context, "message">,
    handle: ThreadHandle,
    work: () => Promise<void>
  ): Promise<void> {
    const wasBusy = this.registry.isStreaming(handle);
    if (wasBusy) {
      await Bot.reactSafe(ctx, "👀");
    }
    void this.registry.enqueueCommand(handle, async () => {
      try {
        await work();
      } catch (err) {
        console.error(`[bot] queued command failed:`, err);
        await this.sendPlain(
          handle,
          `⚠️ ${(err as Error).message ?? String(err)}`
        );
      } finally {
        if (wasBusy) {
          await Bot.reactSafe(ctx, []);
        }
      }
    });
  }

  private static async reactSafe(
    ctx: Filter<Context, "message">,
    reaction: "👀" | []
  ): Promise<void> {
    await ctx.react(reaction).catch((err: unknown) => {
      console.warn(`[bot] react failed:`, err);
    });
  }

  private async cmdChatId(handle: ThreadHandle): Promise<void> {
    const lines = [`Chat ID: <code>${handle.chatId}</code>`];
    if (handle.threadId) {
      lines.push(`Thread ID: <code>${handle.threadId}</code>`);
    }
    await this.sendWithFallback(handle, lines.join("\n"));
  }

  private async cmdCancel(handle: ThreadHandle): Promise<void> {
    const cancelled = await this.registry.cancel(handle);
    await this.sendPlain(
      handle,
      cancelled ? "❌ Cancelled." : "Nothing to cancel."
    );
  }

  private async cmdClear(handle: ThreadHandle): Promise<void> {
    const key = SessionRegistry.key(handle);
    const kb = new InlineKeyboard()
      .text("🚫 Cancel", `${CB_CLEAR_CANCEL}:${key}`)
      .text("👍 Yes", `${CB_CLEAR_CONFIRM}:${key}`);
    await this.sendPlain(
      handle,
      "⚠️ Are you sure you want to reset this thread's chat history and context window?",
      kb
    );
  }

  private async cmdCdRead(handle: ThreadHandle): Promise<void> {
    const entry = this.registry.getEntry(handle);
    const cwd = Paths.abbreviateHome(entry.cwd ?? this.config.cwd);
    const lines = [
      `<b>CWD</b>: <code>${escapeMarkdown(cwd)}</code>`,
      `<b>To Change</b>: <code>/cd &lt;path&gt;</code>`,
    ];
    await this.sendWithFallback(handle, lines.join("\n"));
  }

  private async cmdCdWrite(handle: ThreadHandle, args: string): Promise<void> {
    const entry = this.registry.getEntry(handle);
    const resolved = Paths.resolve(args, entry.cwd ?? this.config.cwd);
    const result = await this.registry.setThreadCwd(handle, resolved);
    if (!result.ok) {
      await this.sendPlain(handle, `⚠️ ${result.error}`);
      return;
    }
    const html = `<b>CWD</b> → <code>${escapeMarkdown(Paths.abbreviateHome(resolved))}</code>`;
    await this.sendWithFallback(handle, html);
  }

  private async cmdModelRead(handle: ThreadHandle): Promise<void> {
    const session = this.registry.peekSession(handle);
    let current = "(unknown)";
    if (session?.model) {
      current = modelId(session.model);
    } else {
      const entry = this.registry.getEntry(handle);
      current = entry.model ?? this.config.model ?? "(unset)";
    }
    const html = [
      `<b>Model</b>: <code>${escapeMarkdown(current)}</code>`,
      `<b>To Change</b>: <code>/model &lt;model_name&gt;</code>`,
    ].join("\n");
    await this.sendWithFallback(handle, html);
  }

  private async cmdModelWrite(
    handle: ThreadHandle,
    args: string
  ): Promise<void> {
    const result = await this.registry.setThreadModel(handle, args);
    if (!result.ok) {
      const bullets = result.candidates
        .map((c) => `• <code>${escapeMarkdown(c)}</code>`)
        .join("\n");
      const header =
        result.kind === "ambiguous"
          ? `⚠️ Multiple matches for "${escapeMarkdown(args)}":`
          : `⚠️ No model matches "${escapeMarkdown(args)}". Available:`;
      const footer =
        result.kind === "ambiguous"
          ? "\n\nPlease choose one above or use a more specific name."
          : "";
      await this.sendWithFallback(handle, `${header}\n${bullets}${footer}`);
      return;
    }
    await this.sendWithFallback(
      handle,
      `<b>Model</b> → <code>${escapeMarkdown(result.id)}</code>`
    );
  }

  private async cmdEffort(handle: ThreadHandle, _args: string): Promise<void> {
    const supported = this.registry.getSupportedThinkingLevels(handle);
    if (supported.length <= 1) {
      await this.sendPlain(
        handle,
        "Effort level for the current model cannot be configured."
      );
      return;
    }
    const entry = this.registry.getEntry(handle);
    const current = entry.thinkingLevel ?? "medium";
    const { kb, html } = this.buildEffortPicker(handle, current, supported);
    await this.sendWithFallback(handle, html, kb);
  }

  private buildEffortPicker(
    handle: ThreadHandle,
    currentLevel: ThinkingLevelOpt,
    supported: readonly ThinkingLevelOpt[]
  ): { readonly kb: InlineKeyboard; readonly html: string } {
    const key = SessionRegistry.key(handle);
    const kb = new InlineKeyboard();
    for (const [i, lvl] of supported.entries()) {
      const label = lvl === currentLevel ? `✅ ${lvl}` : lvl;
      kb.text(label, `${CB_EFFORT}:${lvl}:${key}`);
      if ((i + 1) % 3 === 0 && i < supported.length - 1) {
        kb.row();
      }
    }
    const html = `<b>Effort</b>: <code>${escapeMarkdown(currentLevel)}</code>`;
    return { kb, html };
  }

  private buildLogsPicker(
    handle: ThreadHandle,
    currentMode: LogsMode
  ): { readonly kb: InlineKeyboard; readonly html: string } {
    const key = SessionRegistry.key(handle);
    const kb = new InlineKeyboard();
    const descriptions: string[] = [];
    for (const [i, mode] of LOGS_MODES.entries()) {
      const label = mode === currentMode ? `✅ ${mode}` : mode;
      kb.text(label, `${CB_LOGS}:${mode}:${key}`);
      if ((i + 1) % 2 === 0 && i < LOGS_MODES.length - 1) {
        kb.row();
      }
      descriptions.push(
        `• <code>${escapeMarkdown(mode)}</code>: ${escapeMarkdown(LOGS_DESCRIPTIONS[mode])}`
      );
    }
    const html = [
      `<b>Level</b>: <code>${escapeMarkdown(currentMode)}</code>`,
      "",
      `<b>Options</b>:`,
      ...descriptions,
    ].join("\n");
    return { kb, html };
  }

  private async cmdUsage(handle: ThreadHandle): Promise<void> {
    const lines: string[] = [];
    const session = this.registry.peekSession(handle);
    if (session) {
      const usage = session.getContextUsage();
      const stats = session.getSessionStats();
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
    const entry = this.registry.getEntry(handle);
    lines.push(
      `<b>Cumulative Cost</b>: <code>$${(entry.cumulativeCost ?? 0).toFixed(2)}</code>`
    );
    await this.sendWithFallback(handle, lines.join("\n"));
  }

  private async cmdLogs(handle: ThreadHandle, _args: string): Promise<void> {
    const entry = this.registry.getEntry(handle);
    const current = entry.logsMode ?? "text";
    const { kb, html } = this.buildLogsPicker(handle, current);
    await this.sendWithFallback(handle, html, kb);
  }

  private async cmdUpdate(handle: ThreadHandle): Promise<void> {
    await this.sendPlain(handle, "🔄 updating...");
    const result = await runUpdate();
    if (!result.ok) {
      await this.sendPlain(handle, `⚠️ ${result.error}`);
      return;
    }

    await appendUpdateConfirm(this.config.configDir, {
      chatId: handle.chatId,
      threadId: handle.threadId,
      ts: new Date().toISOString(),
    });
    process.exit(0);
  }

  private async handleCallback(
    ctx: Filter<Context, "callback_query:data">
  ): Promise<void> {
    const data = ctx.callbackQuery.data;
    const colon = data.indexOf(":");
    const action = colon >= 0 ? data.slice(0, colon) : data;
    const keyPart = colon >= 0 ? data.slice(colon + 1) : "";

    if (action === CB_CLEAR_CONFIRM && keyPart) {
      const handle = SessionRegistry.parseKey(keyPart);
      const wasBusy = this.registry.isStreaming(handle);
      await ctx.answerCallbackQuery({
        text: wasBusy ? "Queued — clearing after current turn" : "Cleared",
      });
      void this.registry.enqueueCommand(handle, async () => {
        try {
          await this.registry.clearThread(handle);
          await Bot.safeEditMessage(
            ctx,
            Bot.strikeOriginal(ctx, "Context window cleared.")
          );
        } catch (err) {
          console.error(`[bot] queued clear failed:`, err);
          await Bot.safeEditMessage(
            ctx,
            Bot.strikeOriginal(
              ctx,
              `⚠️ clear failed: ${(err as Error).message}`
            )
          );
        }
      });
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
      const handle = SessionRegistry.parseKey(parts.key);
      await this.registry.setThreadThinkingLevel(handle, parts.value);
      await ctx.answerCallbackQuery({ text: `Effort: ${parts.value}` });
      const supported = this.registry.getSupportedThinkingLevels(handle);
      const { kb, html } = this.buildEffortPicker(
        handle,
        parts.value,
        supported
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
      const handle = SessionRegistry.parseKey(parts.key);
      await this.registry.setThreadLogsMode(handle, parts.value);
      await ctx.answerCallbackQuery({ text: `Logs: ${parts.value}` });
      const { kb, html } = this.buildLogsPicker(handle, parts.value);
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
    return `<s>${escapeMarkdown(original)}</s>\n\n<i>${note}</i>`;
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
    handle: ThreadHandle,
    session: AgentSession,
    prompt: AttachmentPrompt
  ): Promise<void> {
    const entry = this.registry.getEntry(handle);
    const renderer = new Renderer({
      api: this.grammy.api,
      handle,
      logsMode: entry.logsMode ?? "text",
    });
    const unsubscribe = session.subscribe((event) =>
      renderer.handleEvent(event)
    );
    await renderer.start();
    try {
      if (session.isStreaming) {
        await session.prompt(prompt.text, {
          ...prompt.options,
          streamingBehavior: "followUp",
          source: "rpc",
        });
        await renderer.finish("", "ok");
        return;
      }
      await session.prompt(prompt.text, {
        ...prompt.options,
        source: "rpc",
      });
      const final = Bot.extractFinalResult(session);
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
    handle: ThreadHandle,
    html: string,
    replyMarkup?: InlineKeyboard
  ): Promise<void> {
    if (!html) {
      return;
    }
    try {
      await this.grammy.api.sendMessage(handle.chatId, html, {
        parse_mode: "HTML",
        message_thread_id: handle.threadId,
        link_preview_options: { is_disabled: true },
        reply_markup: replyMarkup,
      });
      console.log(
        `[send] chatId=${handle.chatId} threadId=${handle.threadId ?? "main"} html ok (${html.length}b)`
      );
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 400) {
        console.warn(`[send] HTML 400 (${err.description}) — retry plain`);
        await this.sendPlain(handle, html, replyMarkup);
        return;
      }
      throw err;
    }
  }

  private async sendPlain(
    handle: ThreadHandle,
    body: string,
    replyMarkup?: InlineKeyboard
  ): Promise<void> {
    try {
      await this.grammy.api.sendMessage(handle.chatId, body, {
        message_thread_id: handle.threadId,
        link_preview_options: { is_disabled: true },
        reply_markup: replyMarkup,
      });
      console.log(
        `[send] chatId=${handle.chatId} threadId=${handle.threadId ?? "main"} plain ok (${body.length}b)`
      );
    } catch (err) {
      console.error(`[send] plain failed:`, err);
    }
  }

  private static extractFinalResult(session: AgentSession): {
    readonly text: string;
    readonly state: TurnEndState;
  } {
    const messages = session.messages;
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
