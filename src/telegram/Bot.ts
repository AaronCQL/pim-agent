import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  Context,
  type Filter,
  Bot as Grammy,
  GrammyError,
  InlineKeyboard,
} from "grammy";

import { Paths } from "../shared/Paths.ts";
import {
  LOGS_MODES,
  type LogsMode,
  type TelegramConfig,
  type ThinkingLevelOpt,
} from "./config.ts";
import {
  buildPromptWithAttachments,
  type AttachmentPrompt,
} from "./attachments.ts";
import { escape as escapeMarkdown } from "./markdown.ts";
import { modelId } from "./model.ts";
import {
  appendReloadConfirm,
  clearReloadConfirm,
  readReloadConfirm,
} from "./reload.ts";
import { Renderer, type TurnEndState } from "./Renderer.ts";
import { SessionRegistry, type ThreadHandle } from "./SessionRegistry.ts";

const EFFORT_MAP: Record<string, ThinkingLevelOpt> = {
  off: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
  default: "medium",
};

const CB_CLEAR_CONFIRM = "clear-confirm";
const CB_CLEAR_CANCEL = "clear-cancel";

function isLogsMode(value: string): value is LogsMode {
  return (LOGS_MODES as readonly string[]).includes(value);
}

export class Bot {
  private readonly grammy: Grammy;
  private readonly allowSet: ReadonlySet<number>;
  private readonly registry: SessionRegistry;
  private readonly config: TelegramConfig;
  private readonly bootMs = Date.now();

  public constructor(config: TelegramConfig) {
    this.config = config;
    this.grammy = new Grammy(config.token);
    this.allowSet = new Set(config.allow);
    this.registry = new SessionRegistry(config, this.grammy.api);

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
        await this.handleCommand(handle, prompt.text);
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
    await this.processBootReloadConfirm();
    await this.grammy.api.deleteWebhook({ drop_pending_updates: true });
    const username = this.grammy.botInfo.username;
    console.log(`bot @${username} ready`);
    await this.grammy.start();
  }

  public async stop(): Promise<void> {
    await this.grammy.stop();
    await this.registry.disposeAll();
  }

  private async processBootReloadConfirm(): Promise<void> {
    const entries = await readReloadConfirm(this.config.configDir);
    if (entries.length === 0) {
      return;
    }
    await Promise.all(
      entries.map((e) =>
        this.grammy.api
          .sendMessage(e.chatId, `✅ Pim daemon reloaded.`, {
            message_thread_id: e.threadId,
            link_preview_options: { is_disabled: true },
          })
          .catch((err) => console.warn(`[reload-confirm] send failed:`, err))
      )
    );
    await clearReloadConfirm(this.config.configDir);
  }

  private async handleCommand(
    handle: ThreadHandle,
    raw: string
  ): Promise<void> {
    const [first, ...rest] = raw.trim().split(/\s+/);
    const name = (first ?? "").split("@")[0];
    const args = rest.join(" ").trim();
    try {
      switch (name) {
        case "/chatid":
          await this.sendPlain(
            handle,
            `chatId=${handle.chatId}\nthreadId=${handle.threadId ?? "main"}`
          );
          return;
        case "/cancel":
          await this.cmdCancel(handle);
          return;
        case "/clear":
          await this.cmdClear(handle);
          return;
        case "/cwd":
          await this.cmdCwd(handle);
          return;
        case "/cd":
          await this.cmdCd(handle, args);
          return;
        case "/model":
          await this.cmdModel(handle, args);
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
        case "/reload":
          await this.cmdReload(handle);
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

  private async cmdCancel(handle: ThreadHandle): Promise<void> {
    const cancelled = await this.registry.cancel(handle);
    await this.sendPlain(
      handle,
      cancelled ? "❌ Cancelled." : "Nothing running."
    );
  }

  private async cmdClear(handle: ThreadHandle): Promise<void> {
    const key = SessionRegistry.key(handle);
    const kb = new InlineKeyboard()
      .text("Clear", `${CB_CLEAR_CONFIRM}:${key}`)
      .text("Cancel", `${CB_CLEAR_CANCEL}:${key}`);
    await this.grammy.api.sendMessage(
      handle.chatId,
      "Clear this thread's session? Cumulative cost is preserved.",
      {
        message_thread_id: handle.threadId,
        reply_markup: kb,
        link_preview_options: { is_disabled: true },
      }
    );
  }

  private async cmdCwd(handle: ThreadHandle): Promise<void> {
    const entry = this.registry.getEntry(handle);
    const cwd = entry.cwd ?? this.config.cwd;
    await this.sendPlain(handle, `cwd: ${Paths.abbreviateHome(cwd)}`);
  }

  private async cmdCd(handle: ThreadHandle, args: string): Promise<void> {
    if (!args) {
      await this.sendPlain(handle, "Usage: /cd <path>");
      return;
    }
    if (this.registry.isStreaming(handle)) {
      await this.sendPlain(
        handle,
        "Cannot /cd while a turn is in flight. /cancel first."
      );
      return;
    }
    const entry = this.registry.getEntry(handle);
    const resolved = Paths.resolve(args, entry.cwd ?? this.config.cwd);
    const result = await this.registry.setThreadCwd(handle, resolved);
    if (!result.ok) {
      await this.sendPlain(handle, `⚠️ ${result.error}`);
      return;
    }
    await this.sendPlain(
      handle,
      `cwd → ${Paths.abbreviateHome(resolved)} (new session next turn)`
    );
  }

  private async cmdModel(handle: ThreadHandle, args: string): Promise<void> {
    if (!args) {
      let current = "(unknown)";
      await this.registry.enqueue(handle, async (session) => {
        if (session.model) {
          current = modelId(session.model);
        }
      });
      const html = [
        `<b>Current Model</b>: <code>${escapeMarkdown(current)}</code>`,
        `<b>To Change</b>: <code>/model &lt;model_name&gt;</code>`,
      ].join("\n");
      await this.sendWithFallback(handle, html);
      return;
    }
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
        result.kind === "ambiguous" ? "\nPlease be more specific." : "";
      await this.sendWithFallback(handle, `${header}\n${bullets}${footer}`);
      return;
    }
    await this.sendPlain(handle, `model → ${result.id}`);
  }

  private async cmdEffort(handle: ThreadHandle, args: string): Promise<void> {
    const level = EFFORT_MAP[args];
    if (!level) {
      await this.sendPlain(
        handle,
        `Usage: /effort ${Object.keys(EFFORT_MAP).join("|")}`
      );
      return;
    }
    await this.registry.setThreadThinkingLevel(handle, level);
    const display = args === "default" ? "default (medium)" : level;
    await this.sendPlain(handle, `effort → ${display}`);
  }

  private async cmdUsage(handle: ThreadHandle): Promise<void> {
    const lines: string[] = [];
    await this.registry.enqueue(handle, async (session) => {
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
    });
    const entry = this.registry.getEntry(handle);
    lines.push(
      `<b>Cumulative Cost</b>: <code>$${(entry.cumulativeCost ?? 0).toFixed(2)}</code>`
    );
    await this.sendWithFallback(handle, lines.join("\n"));
  }

  private async cmdLogs(handle: ThreadHandle, args: string): Promise<void> {
    if (!isLogsMode(args)) {
      const current = this.registry.getEntry(handle).logsMode ?? "text";
      await this.sendPlain(
        handle,
        `logs: ${current}\nUsage: /logs ${LOGS_MODES.join("|")}`
      );
      return;
    }
    await this.registry.setThreadLogsMode(handle, args);
    await this.sendPlain(handle, `logs → ${args}`);
  }

  private async cmdReload(handle: ThreadHandle): Promise<void> {
    const since = Date.now() - this.bootMs;
    if (since < 30_000) {
      await this.sendPlain(
        handle,
        `⚠️ /reload throttled (daemon booted ${(since / 1000).toFixed(0)}s ago)`
      );
      return;
    }
    const wrapper = Bot.detectWrapper();
    if (wrapper === "none") {
      await this.sendPlain(
        handle,
        "⚠️ daemon not under a process supervisor — restart manually"
      );
      return;
    }

    await appendReloadConfirm(this.config.configDir, {
      chatId: handle.chatId,
      threadId: handle.threadId,
      ts: new Date().toISOString(),
    });
    await this.sendPlain(handle, "🔄 reloading...");

    const unit = process.env.PIM_TELEGRAM_UNIT ?? "pim-telegram";
    const cmd =
      wrapper === "systemd"
        ? ["systemctl", "--user", "restart", unit]
        : [
            "launchctl",
            "kickstart",
            "-k",
            `gui/${process.getuid?.() ?? 0}/${unit}`,
          ];
    try {
      const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
      const code = await proc.exited;
      if (code !== 0) {
        const stderr = await new Response(proc.stderr).text();
        await this.sendPlain(
          handle,
          `⚠️ wrapper exit ${code}: ${stderr.trim() || "(no stderr)"}`
        );
        await clearReloadConfirm(this.config.configDir);
        return;
      }
    } catch (err) {
      console.error(`[reload] spawn failed:`, err);
      await this.sendPlain(
        handle,
        `⚠️ spawn failed: ${(err as Error).message}`
      );
      await clearReloadConfirm(this.config.configDir);
      return;
    }
    process.exit(0);
  }

  private static detectWrapper(): "systemd" | "launchd" | "none" {
    const env = process.env.PIM_TELEGRAM_WRAPPER;
    if (env === "systemd" || env === "launchd" || env === "none") {
      return env;
    }
    if (process.platform === "linux") {
      return "systemd";
    }
    if (process.platform === "darwin") {
      return "launchd";
    }
    return "none";
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
      await this.registry.clearThread(handle);
      await ctx.answerCallbackQuery({ text: "Cleared" });
      try {
        await ctx.editMessageText("✅ Session cleared.");
      } catch {
        // Message may have aged out past Telegram's edit window — non-fatal.
      }
      return;
    }
    if (action === CB_CLEAR_CANCEL) {
      await ctx.answerCallbackQuery({ text: "Cancelled" });
      try {
        await ctx.editMessageText("Cancelled.");
      } catch {
        // Message may have aged out past Telegram's edit window — non-fatal.
      }
      return;
    }
    await ctx.answerCallbackQuery();
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
    html: string
  ): Promise<void> {
    if (!html) {
      return;
    }
    try {
      await this.grammy.api.sendMessage(handle.chatId, html, {
        parse_mode: "HTML",
        message_thread_id: handle.threadId,
        link_preview_options: { is_disabled: true },
      });
      console.log(
        `[send] chatId=${handle.chatId} threadId=${handle.threadId ?? "main"} html ok (${html.length}b)`
      );
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 400) {
        console.warn(`[send] HTML 400 (${err.description}) — retry plain`);
        await this.sendPlain(handle, html);
        return;
      }
      throw err;
    }
  }

  private async sendPlain(handle: ThreadHandle, body: string): Promise<void> {
    try {
      await this.grammy.api.sendMessage(handle.chatId, body, {
        message_thread_id: handle.threadId,
        link_preview_options: { is_disabled: true },
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
