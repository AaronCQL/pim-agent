import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Bot as Grammy } from "grammy";

import { Commands } from "./Commands";
import type { TelegramConfig } from "./Config";
import { Message, type Prompt } from "./Message";
import { Renderer, type TurnEndState } from "./Renderer";
import { Session, type SessionId } from "./Session";
import { SessionRegistry } from "./SessionRegistry";
import { Supervisor } from "./Supervisor";
import type { ScheduledTask } from "./TaskSchema";
import { TaskScheduler } from "./TaskScheduler";

export class Bot {
  private readonly grammy: Grammy;
  private readonly allowSet: ReadonlySet<number>;
  private readonly registry: SessionRegistry;
  private readonly scheduler: TaskScheduler;
  private readonly config: TelegramConfig;
  private readonly commands: Commands;

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
    this.commands = new Commands(config, this.grammy.api, this.registry);

    this.grammy.on("callback_query:data", async (ctx) => {
      if (!this.allowSet.has(ctx.chat?.id ?? -1)) {
        return;
      }
      await this.commands.handleCallback(ctx);
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
      let prompt: Prompt | undefined;
      try {
        prompt = await Message.toPrompt(
          ctx,
          this.config.token,
          this.config.configDir,
          sessionId
        );
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        console.error(`[recv] attachment download failed:`, err);
        await this.grammy.api
          .sendMessage(sessionId.chatId, `⚠️ ${msg}`, {
            message_thread_id: sessionId.threadId,
            link_preview_options: { is_disabled: true },
          })
          .catch((e) => console.error(`[send] plain failed:`, e));
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
        await this.commands.handleCommand(ctx, session, prompt.text);
        return;
      }

      void session.run(
        (agent) => this.handleTurn(session, agent, prompt),
        session.temporary ? { isolated: true } : undefined
      );
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
    this.registry.setBotUsername(username);
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
    const prompt: Prompt = { text: task.prompt, options: {} };
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

  private async handleTurn(
    session: Session,
    agent: AgentSession,
    prompt: Prompt
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
