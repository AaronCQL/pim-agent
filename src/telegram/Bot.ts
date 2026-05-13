import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Bot as Grammy, GrammyError } from "grammy";

import type { TelegramConfig } from "./Config.ts";
import { Markdown } from "./Markdown.ts";
import { SessionRegistry } from "./SessionRegistry.ts";

type SendTarget = {
  readonly chatId: number;
  readonly threadId: number | undefined;
};

export class Bot {
  private readonly grammy: Grammy;
  private readonly allowSet: ReadonlySet<number>;
  private readonly registry: SessionRegistry;

  public constructor(config: TelegramConfig) {
    this.grammy = new Grammy(config.token);
    this.allowSet = new Set(config.allow);
    this.registry = new SessionRegistry(config);

    this.grammy.on("message:text", async (ctx) => {
      const chatId = ctx.chat.id;
      if (!this.allowSet.has(chatId)) {
        console.log(`[recv] reject chatId=${chatId} (not in allow-list)`);
        return;
      }
      const threadId = ctx.message.message_thread_id;
      const text = ctx.message.text;
      const key = SessionRegistry.key(chatId, threadId);
      const preview = text.slice(0, 120).replace(/\s+/g, " ");
      console.log(
        `[recv] chatId=${chatId} threadId=${threadId ?? "main"} ${preview}`
      );
      void this.registry.enqueue(key, (session) =>
        this.handleTurn({ chatId, threadId }, session, text)
      );
    });

    this.grammy.catch((err) => {
      console.error("[bot] handler error:", err.error);
    });
  }

  public async run(): Promise<void> {
    await this.grammy.init();
    await this.grammy.api.deleteWebhook({ drop_pending_updates: true });
    const username = this.grammy.botInfo.username;
    console.log(`bot @${username} ready`);
    await this.grammy.start();
  }

  public async stop(): Promise<void> {
    await this.grammy.stop();
    await this.registry.disposeAll();
  }

  private async handleTurn(
    target: SendTarget,
    session: AgentSession,
    text: string
  ): Promise<void> {
    try {
      if (session.isStreaming) {
        await session.prompt(text, { streamingBehavior: "followUp" });
        return;
      }
      await session.prompt(text);
      const final = Bot.extractFinalText(session);
      if (final) {
        await this.sendWithFallback(target, Markdown.toHtml(final));
      }
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      console.error(`[bot] turn failed:`, err);
      await this.sendPlain(target, `⚠️ ${msg}`);
    }
  }

  private async sendWithFallback(
    target: SendTarget,
    html: string
  ): Promise<void> {
    if (!html) {
      return;
    }
    try {
      await this.grammy.api.sendMessage(target.chatId, html, {
        parse_mode: "HTML",
        message_thread_id: target.threadId,
        link_preview_options: { is_disabled: true },
      });
      console.log(
        `[send] chatId=${target.chatId} threadId=${target.threadId ?? "main"} html ok (${html.length}b)`
      );
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 400) {
        console.warn(`[send] HTML 400 (${err.description}) — retry plain`);
        await this.sendPlain(target, html);
        return;
      }
      throw err;
    }
  }

  private async sendPlain(target: SendTarget, body: string): Promise<void> {
    try {
      await this.grammy.api.sendMessage(target.chatId, body, {
        message_thread_id: target.threadId,
        link_preview_options: { is_disabled: true },
      });
      console.log(
        `[send] chatId=${target.chatId} threadId=${target.threadId ?? "main"} plain ok (${body.length}b)`
      );
    } catch (err) {
      console.error(`[send] plain failed:`, err);
    }
  }

  private static extractFinalText(session: AgentSession): string {
    const messages = session.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!;
      if (msg.role !== "assistant") {
        continue;
      }
      if (msg.stopReason === "error" || msg.stopReason === "aborted") {
        return msg.errorMessage ?? "";
      }
      const parts: string[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push(block.text);
        }
      }
      return parts.join("").trim();
    }
    return "";
  }
}
