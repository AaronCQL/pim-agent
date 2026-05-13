import {
  AgentSession,
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import type { TelegramConfig } from "./Config.ts";

export type SessionKey = string;

type Tail = Promise<void>;

export class SessionRegistry {
  private readonly config: TelegramConfig;
  private readonly sessions = new Map<SessionKey, AgentSession>();
  private readonly tails = new Map<SessionKey, Tail>();

  public constructor(config: TelegramConfig) {
    this.config = config;
  }

  public static key(chatId: number, threadId: number | undefined): SessionKey {
    return `${chatId}-${threadId ?? "main"}`;
  }

  public enqueue(
    key: SessionKey,
    work: (session: AgentSession) => Promise<void>
  ): Promise<void> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(async () => {
      const session = await this.getOrCreate(key);
      await work(session);
    });
    this.tails.set(
      key,
      next.catch((err: unknown) => {
        console.error(`[registry] tail error for key=${key}:`, err);
      })
    );
    return next;
  }

  public async disposeAll(): Promise<void> {
    const pending = Array.from(this.tails.values()).map((p) =>
      p.catch(() => {})
    );
    await Promise.all(pending);
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    this.tails.clear();
  }

  private async getOrCreate(key: SessionKey): Promise<AgentSession> {
    const existing = this.sessions.get(key);
    if (existing) {
      return existing;
    }
    const { session } = await createAgentSession({
      cwd: this.config.cwd,
      sessionManager: SessionManager.inMemory(this.config.cwd),
    });
    this.sessions.set(key, session);
    return session;
  }
}
