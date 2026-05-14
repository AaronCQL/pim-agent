import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  AgentSession,
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  type PromptOptions,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Api } from "grammy";
import { mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  loadState,
  saveStateAtomic,
  type LogsMode,
  type TelegramConfig,
  type TelegramState,
  type ThinkingLevelOpt,
  type ThreadEntry,
} from "./config.ts";
import { modelId, resolveModel } from "./model.ts";
import { buildSendFileTool } from "./sendTool.ts";
import { loadWrappedThreadInstruction } from "./threadInstruction.ts";

export type SessionKey = string;

export type ThreadHandle = {
  readonly chatId: number;
  readonly threadId: number | undefined;
};

type WorkQueue = Promise<void>;

type TelegramSession = {
  readonly handle: ThreadHandle;
  readonly session: AgentSession;
  readonly promptRef: { wrapped: string | undefined };
  unsubscribe: () => void;
  lastUsed: number;
  lastTurnCost: number;
};

const LRU_CAP = 16;
const MAIN = "main";

export class SessionRegistry {
  private readonly config: TelegramConfig;
  private readonly api: Api;
  private readonly workQueues = new Map<SessionKey, WorkQueue>();
  private readonly sessionCache = new Map<SessionKey, TelegramSession>();
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly settingsManagers = new Map<string, SettingsManager>();
  private readonly agentDir: string;
  private state: TelegramState;
  private stateLoaded = false;
  private initPromise: Promise<void> | undefined;

  public constructor(config: TelegramConfig, api: Api) {
    this.config = config;
    this.api = api;
    this.agentDir = getAgentDir();
    this.authStorage = AuthStorage.create(join(this.agentDir, "auth.json"));
    this.modelRegistry = ModelRegistry.create(
      this.authStorage,
      join(this.agentDir, "models.json")
    );
    this.state = { threads: {} };
  }

  public static key(handle: ThreadHandle): SessionKey {
    return `${handle.chatId}-${handle.threadId ?? MAIN}`;
  }

  public static parseKey(key: SessionKey): ThreadHandle {
    const idx = key.lastIndexOf("-");
    const chatId = Number(key.slice(0, idx));
    const tail = key.slice(idx + 1);
    return {
      chatId,
      threadId: tail === MAIN ? undefined : Number(tail),
    };
  }

  public async init(): Promise<void> {
    if (this.stateLoaded) {
      return;
    }
    this.initPromise ??= this.loadInitialState().catch((err: unknown) => {
      this.initPromise = undefined;
      throw err;
    });
    await this.initPromise;
  }

  private async loadInitialState(): Promise<void> {
    const loaded = await loadState(this.config.configDir);
    this.state = { threads: { ...loaded.threads } };
    await mkdir(join(this.config.configDir, "sessions"), { recursive: true });
    await mkdir(join(this.config.configDir, "instructions"), {
      recursive: true,
    });
    this.stateLoaded = true;
  }

  private requireInitialized(): void {
    if (!this.stateLoaded) {
      throw new Error("SessionRegistry.init() must complete before use");
    }
  }

  public enqueue(
    handle: ThreadHandle,
    work: (session: AgentSession) => Promise<void>
  ): Promise<void> {
    this.requireInitialized();
    const key = SessionRegistry.key(handle);
    const prev = this.workQueues.get(key) ?? Promise.resolve();
    const next = prev.then(async () => {
      const session = await this.getOrCreate(handle);
      await work(session);
    });
    const tail = next.catch((err: unknown) => {
      console.error(`[registry] tail error for key=${key}:`, err);
    });
    this.workQueues.set(key, tail);
    void tail.finally(() => {
      if (this.workQueues.get(key) === tail) {
        this.workQueues.delete(key);
      }
    });
    return next;
  }

  public getEntry(handle: ThreadHandle): ThreadEntry {
    this.requireInitialized();
    return this.state.threads[SessionRegistry.key(handle)] ?? {};
  }

  public isStreaming(handle: ThreadHandle): boolean {
    return (
      this.sessionCache.get(SessionRegistry.key(handle))?.session.isStreaming ??
      false
    );
  }

  public async cancel(handle: ThreadHandle): Promise<boolean> {
    const live = this.sessionCache.get(SessionRegistry.key(handle));
    if (!live || !live.session.isStreaming) {
      return false;
    }
    await live.session.abort();
    return true;
  }

  public async setThreadCwd(
    handle: ThreadHandle,
    newCwd: string
  ): Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: string }
  > {
    this.requireInitialized();
    try {
      const st = await stat(newCwd);
      if (!st.isDirectory()) {
        return { ok: false, error: `not a directory: ${newCwd}` };
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { ok: false, error: `path does not exist: ${newCwd}` };
      }
      return { ok: false, error: `stat failed: ${(err as Error).message}` };
    }
    const key = SessionRegistry.key(handle);
    await this.evictAndArchive(key);
    await this.patchEntry(key, { cwd: newCwd, sessionPath: undefined });
    return { ok: true };
  }

  public async setThreadModel(
    handle: ThreadHandle,
    pattern: string
  ): Promise<
    | { readonly ok: true; readonly id: string }
    | {
        readonly ok: false;
        readonly kind: "none" | "ambiguous";
        readonly candidates: readonly string[];
      }
  > {
    this.requireInitialized();
    const result = resolveModel(this.modelRegistry, pattern);
    if (result.kind === "none" || result.kind === "ambiguous") {
      return {
        ok: false,
        kind: result.kind,
        candidates: result.candidates,
      };
    }
    const id = modelId(result.model);
    const key = SessionRegistry.key(handle);
    if (this.state.threads[key]?.model === id) {
      return { ok: true, id };
    }
    await this.patchEntry(key, { model: id });
    const live = this.sessionCache.get(key);
    if (live) {
      await live.session.setModel(result.model);
    }
    return { ok: true, id };
  }

  public async setThreadThinkingLevel(
    handle: ThreadHandle,
    level: ThinkingLevelOpt
  ): Promise<void> {
    this.requireInitialized();
    const key = SessionRegistry.key(handle);
    if (this.state.threads[key]?.thinkingLevel === level) {
      return;
    }
    await this.patchEntry(key, { thinkingLevel: level });
    const live = this.sessionCache.get(key);
    if (live) {
      live.session.setThinkingLevel(level as ThinkingLevel);
    }
  }

  public async setThreadLogsMode(
    handle: ThreadHandle,
    logsMode: LogsMode
  ): Promise<void> {
    this.requireInitialized();
    await this.patchEntry(SessionRegistry.key(handle), { logsMode });
  }

  public async steerIfStreaming(
    handle: ThreadHandle,
    text: string,
    options: Pick<PromptOptions, "images">
  ): Promise<boolean> {
    const live = this.sessionCache.get(SessionRegistry.key(handle));
    if (!live?.session.isStreaming) {
      return false;
    }
    await live.session.prompt(text, {
      ...options,
      streamingBehavior: "steer",
      source: "rpc",
    });
    return true;
  }

  public async clearThread(handle: ThreadHandle): Promise<void> {
    this.requireInitialized();
    const key = SessionRegistry.key(handle);
    await this.evictAndArchive(key);
    await this.patchEntry(key, { sessionPath: undefined });
  }

  public async disposeAll(): Promise<void> {
    const pending = Array.from(this.workQueues.values()).map((p) =>
      p.catch(() => {})
    );
    await Promise.all(pending);
    for (const live of this.sessionCache.values()) {
      live.unsubscribe();
      live.session.dispose();
    }
    this.sessionCache.clear();
    this.workQueues.clear();
    if (this.stateLoaded) {
      await this.flushState();
    }
  }

  private defaultSessionPath(key: SessionKey): string {
    return join(this.config.configDir, "sessions", `${key}.jsonl`);
  }

  private async patchEntry(
    key: SessionKey,
    patch: Partial<ThreadEntry>
  ): Promise<void> {
    this.requireInitialized();
    const prev = this.state.threads[key] ?? {};
    this.state.threads[key] = { ...prev, ...patch };
    await this.flushState();
  }

  private async flushState(): Promise<void> {
    try {
      await saveStateAtomic(this.config.configDir, this.state);
    } catch (err) {
      console.warn(`[registry] state save failed:`, err);
    }
  }

  private async evictAndArchive(key: SessionKey): Promise<void> {
    const live = this.sessionCache.get(key);
    if (live) {
      live.unsubscribe();
      live.session.dispose();
      this.sessionCache.delete(key);
    }
    const prev = this.state.threads[key];
    const path = prev?.sessionPath ?? this.defaultSessionPath(key);
    const archived = `${path}.archived-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      await rename(path, archived);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[registry] archive ${path}:`, err);
      }
    }
  }

  private async getOrCreate(handle: ThreadHandle): Promise<AgentSession> {
    this.requireInitialized();
    const key = SessionRegistry.key(handle);
    const existing = this.sessionCache.get(key);
    if (existing) {
      existing.lastUsed = Date.now();
      const wrapped = await loadWrappedThreadInstruction({
        configDir: this.config.configDir,
        chatId: handle.chatId,
        threadId: handle.threadId,
      });
      if (existing.promptRef.wrapped !== wrapped) {
        existing.promptRef.wrapped = wrapped;
        await existing.session.reload();
      }
      return existing.session;
    }

    this.evictIfNeeded();

    const entry = this.state.threads[key] ?? {};
    const cwd = entry.cwd ?? this.config.cwd;
    const sessionPath = entry.sessionPath ?? this.defaultSessionPath(key);
    const sessionManager = SessionManager.open(sessionPath, undefined, cwd);
    const settingsManager = this.settingsManagerFor(cwd);
    const wrapped = await loadWrappedThreadInstruction({
      configDir: this.config.configDir,
      chatId: handle.chatId,
      threadId: handle.threadId,
    });
    const promptRef = { wrapped };

    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: this.agentDir,
      settingsManager,
      appendSystemPromptOverride: (base) => {
        return promptRef.wrapped ? [...base, promptRef.wrapped] : base;
      },
    });

    await loader.reload();

    const defaultModelId = entry.model ?? this.config.model;
    let model;
    if (defaultModelId) {
      const resolved = resolveModel(this.modelRegistry, defaultModelId);
      if (resolved.kind === "ok") {
        model = resolved.model;
      } else {
        console.warn(
          `[registry] model "${defaultModelId}" did not resolve cleanly (${resolved.kind})`
        );
      }
    }

    const sendFile = buildSendFileTool({
      api: this.api,
      handle,
      cwd,
    });

    const { session } = await createAgentSession({
      cwd,
      agentDir: this.agentDir,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      settingsManager,
      resourceLoader: loader,
      sessionManager,
      model,
      thinkingLevel: entry.thinkingLevel as ThinkingLevel | undefined,
      customTools: [sendFile],
    });

    const live: TelegramSession = {
      handle,
      session,
      promptRef,
      unsubscribe: () => {},
      lastUsed: Date.now(),
      lastTurnCost: session.getSessionStats().cost ?? 0,
    };
    live.unsubscribe = session.subscribe((event) => {
      if (event.type !== "turn_end") {
        return;
      }
      const total = session.getSessionStats().cost ?? 0;
      const delta = total - live.lastTurnCost;
      if (delta <= 0) {
        return;
      }
      live.lastTurnCost = total;
      const prevEntry = this.state.threads[key] ?? {};
      this.state.threads[key] = {
        ...prevEntry,
        cumulativeCost: (prevEntry.cumulativeCost ?? 0) + delta,
      };
      void this.flushState();
    });
    this.sessionCache.set(key, live);

    await this.patchEntry(key, { cwd, sessionPath });

    return session;
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
    if (this.sessionCache.size < LRU_CAP) {
      return;
    }
    let oldestKey: SessionKey | undefined;
    let oldestTime = Infinity;
    for (const [k, v] of this.sessionCache) {
      if (v.lastUsed < oldestTime) {
        oldestTime = v.lastUsed;
        oldestKey = k;
      }
    }
    if (!oldestKey) {
      return;
    }
    const entry = this.sessionCache.get(oldestKey)!;
    entry.unsubscribe();
    entry.session.dispose();
    this.sessionCache.delete(oldestKey);
  }
}
