import {
  AuthStorage,
  getAgentDir,
  ModelRegistry,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Api } from "grammy";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { Fs } from "../shared/Fs";
import { type TelegramConfig } from "./Config";
import { Session, type SessionId, type SessionSettings } from "./Session";
import type { TaskScheduler } from "./TaskScheduler";

const LRU_CAP = 16;

export class SessionRegistry {
  private readonly config: TelegramConfig;
  private readonly api: Api;
  private readonly scheduler: TaskScheduler;
  private readonly cache = new Map<string, Session>();
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly settingsManagers = new Map<string, SettingsManager>();
  private readonly agentDir: string;
  private settings: Map<string, SessionSettings> = new Map();
  private initialized = false;
  private initPromise: Promise<void> | undefined;

  public constructor(
    config: TelegramConfig,
    api: Api,
    scheduler: TaskScheduler
  ) {
    this.config = config;
    this.api = api;
    this.scheduler = scheduler;
    this.agentDir = getAgentDir();
    this.authStorage = AuthStorage.create(join(this.agentDir, "auth.json"));
    this.modelRegistry = ModelRegistry.create(
      this.authStorage,
      join(this.agentDir, "models.json")
    );
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
    const key = Session.encodeId(sessionId);
    const cached = this.cache.get(key);
    if (cached) {
      cached.lastUsed = Date.now();
      return cached;
    }
    this.evictIfNeeded();
    const session = new Session({
      id: sessionId,
      settings: this.settings.get(key) ?? {},
      config: this.config,
      api: this.api,
      agentDir: this.agentDir,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      scheduler: this.scheduler,
      settingsManagerFor: (cwd) => this.settingsManagerFor(cwd),
      persistSettings: (patch) => this.persistSettings(key, patch),
    });
    this.cache.set(key, session);
    return session;
  }

  public async disposeAll(): Promise<void> {
    for (const session of this.cache.values()) {
      session.dispose();
    }
    this.cache.clear();
    if (this.initialized) {
      await this.flushSettings();
    }
  }

  private async bootstrap(): Promise<void> {
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

  private settingsManagerFor(cwd: string): SettingsManager {
    const existing = this.settingsManagers.get(cwd);
    if (existing) {
      return existing;
    }
    const settingsManager = SettingsManager.create(cwd, this.agentDir);
    this.settingsManagers.set(cwd, settingsManager);
    return settingsManager;
  }

  private evictIfNeeded(): void {
    if (this.cache.size < LRU_CAP) {
      return;
    }
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [k, v] of this.cache) {
      if (v.lastUsed < oldestTime) {
        oldestTime = v.lastUsed;
        oldestKey = k;
      }
    }
    if (!oldestKey) {
      return;
    }
    const entry = this.cache.get(oldestKey)!;
    entry.dispose();
    this.cache.delete(oldestKey);
  }
}
