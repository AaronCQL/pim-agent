import type { Api } from "grammy";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { AgentRuntime } from "#core/session/AgentRuntime";
import { SessionCache } from "#core/session/SessionCache";
import { Fs } from "#core/shared/Fs";
import { type TelegramConfig } from "./Config";
import {
  encodeId,
  Session,
  type SessionId,
  type SessionSettings,
} from "./Session";
import type { TaskScheduler } from "./TaskScheduler";

export class SessionRegistry {
  private readonly config: TelegramConfig;
  private readonly api: Api;
  private readonly scheduler: TaskScheduler;
  private readonly runtime: AgentRuntime;
  private readonly cache = new SessionCache<Session>();
  private settings: Map<string, SessionSettings> = new Map();
  private initialized = false;
  private initPromise: Promise<void> | undefined;
  private botUsername: string | undefined;

  public constructor(
    config: TelegramConfig,
    api: Api,
    scheduler: TaskScheduler,
    runtime: AgentRuntime
  ) {
    this.config = config;
    this.api = api;
    this.scheduler = scheduler;
    this.runtime = runtime;
  }

  public setBotUsername(username: string): void {
    this.botUsername = username;
  }

  public async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initPromise ??= this.bootstrap().catch((err: unknown) => {
      this.initPromise = undefined;
      throw err;
    });
    await this.initPromise;
  }

  public get(sessionId: SessionId): Session {
    this.requireInitialized();
    const key = encodeId(sessionId);
    const cached = this.cache.touch(key);
    if (cached) {
      return cached;
    }
    return this.cache.adopt(
      key,
      new Session({
        id: sessionId,
        settings: this.settings.get(key) ?? {},
        config: this.config,
        api: this.api,
        runtime: this.runtime,
        scheduler: this.scheduler,
        persistSettings: (patch) => this.persistSettings(key, patch),
        getBotUsername: () => this.botUsername,
      })
    );
  }

  public async disposeAll(): Promise<void> {
    await this.cache.disposeAll();
    if (this.initialized) {
      await this.flushSettings();
    }
  }

  private async bootstrap(): Promise<void> {
    await this.runtime.init();
    const loaded = await Fs.readJsonOrEmpty<Record<string, SessionSettings>>(
      join(this.config.configDir, "state.json"),
      {}
    );
    this.settings = new Map(Object.entries(loaded));
    await mkdir(join(this.config.configDir, "sessions"), { recursive: true });
    await mkdir(join(this.config.configDir, "isolated-sessions"), {
      recursive: true,
    });
    await mkdir(join(this.config.configDir, "instructions"), {
      recursive: true,
    });
    this.initialized = true;
  }

  private requireInitialized(): void {
    if (!this.initialized) {
      throw new Error("SessionRegistry.init() must complete before use");
    }
  }

  private async persistSettings(
    key: string,
    patch: Partial<SessionSettings>
  ): Promise<void> {
    const prev = this.settings.get(key) ?? {};
    this.settings.set(key, { ...prev, ...patch });
    await this.flushSettings();
  }

  private async flushSettings(): Promise<void> {
    try {
      await Fs.writeAtomic(
        join(this.config.configDir, "state.json"),
        JSON.stringify(Object.fromEntries(this.settings), null, 2)
      );
    } catch (err) {
      console.warn(`[registry] state save failed:`, err);
    }
  }
}
