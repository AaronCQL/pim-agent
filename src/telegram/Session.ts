import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels as piGetSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Api as ModelApi, Model } from "@earendil-works/pi-ai";
import {
  AgentSession,
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Api } from "grammy";
import { mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { FuzzyMatcher, type FuzzyCandidate } from "../shared/FuzzyMatcher";
import type { LogsMode, TelegramConfig, ThinkingLevelOpt } from "./Config";
import { SendFileTool } from "./SendFileTool";
import type { TaskScheduler } from "./TaskScheduler";
import { TaskTool } from "./TaskTool";

export type SessionId = {
  readonly chatId: number;
  readonly threadId: number | undefined;
};

export type SessionSettings = {
  readonly cwd?: string;
  readonly model?: string;
  readonly thinkingLevel?: ThinkingLevelOpt;
  readonly logsMode?: LogsMode;
  readonly sessionPath?: string;
  readonly cumulativeCost?: number;
};

export type SetCwdResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export type SetModelResult =
  | { readonly ok: true; readonly id: string }
  | {
      readonly ok: false;
      readonly kind: "none" | "ambiguous";
      readonly candidates: readonly string[];
    };

export type SessionDeps = {
  readonly id: SessionId;
  readonly settings: SessionSettings;
  readonly config: TelegramConfig;
  readonly api: Api;
  readonly agentDir: string;
  readonly authStorage: AuthStorage;
  readonly modelRegistry: ModelRegistry;
  readonly scheduler: TaskScheduler;
  readonly settingsManagerFor: (cwd: string) => SettingsManager;
  readonly persistSettings: (patch: Partial<SessionSettings>) => Promise<void>;
};

type ModelResolveResult =
  | { readonly kind: "ok"; readonly model: Model<ModelApi> }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] }
  | { readonly kind: "none"; readonly candidates: readonly string[] };

const MAIN = "main";

export class Session {
  public readonly id: SessionId;
  private readonly deps: SessionDeps;
  private currentSettings: SessionSettings;
  private cached: AgentSession | undefined;
  private cachedUnsubscribe: (() => void) | undefined;
  private cachedPromptInstruction: string | undefined;
  private cachedLastTurnCost = 0;
  private queue: Promise<void> = Promise.resolve();
  public lastUsed = Date.now();

  public constructor(deps: SessionDeps) {
    this.deps = deps;
    this.id = deps.id;
    this.currentSettings = deps.settings;
  }

  public static encodeId(id: SessionId): string {
    return `${id.chatId}-${id.threadId ?? MAIN}`;
  }

  public static decodeId(s: string): SessionId {
    const idx = s.lastIndexOf("-");
    const chatId = Number(s.slice(0, idx));
    const tail = s.slice(idx + 1);
    return {
      chatId,
      threadId: tail === MAIN ? undefined : Number(tail),
    };
  }

  public get settings(): SessionSettings {
    return this.currentSettings;
  }

  public get isStreaming(): boolean {
    return this.cached?.isStreaming ?? false;
  }

  public get agentSession(): AgentSession | undefined {
    return this.cached;
  }

  public get currentModelId(): string | undefined {
    const model = this.cached?.model ?? this.resolveDefaultModel();
    return model ? Session.modelId(model) : undefined;
  }

  public get supportedThinkingLevels(): readonly ThinkingLevelOpt[] {
    const model = this.cached?.model ?? this.resolveDefaultModel();
    if (!model) {
      return [];
    }
    return piGetSupportedThinkingLevels(model) as ThinkingLevelOpt[];
  }

  /**
   * Run `work` as a turn against this session's agent. Serialized: turns for
   * the same `SessionId` execute one at a time in the order they were
   * submitted, so callers can fire-and-forget without races.
   *
   * Default (`isolated: false`): work runs against the cached `AgentSession`,
   * which is built on first call and reused across turns (chat history
   * persists, thread-instruction file is re-read between turns).
   *
   * `isolated: true`: work runs against a fresh one-shot `AgentSession`
   * written under `tasks-sessions/`, disposed when the work resolves. No
   * history, no shared state with the cached agent. Used for scheduled tasks
   * that explicitly opt out of the chat thread.
   */
  public run(
    work: (agent: AgentSession) => Promise<void>,
    opts?: { readonly isolated?: boolean }
  ): Promise<void> {
    return this.enqueue(async () => {
      if (opts?.isolated) {
        const isolated = await this.buildIsolatedAgent();
        try {
          await work(isolated);
        } finally {
          isolated.dispose();
        }
        return;
      }
      const agent = await this.ensureCached();
      await work(agent);
    });
  }

  public async cancel(): Promise<boolean> {
    if (!this.cached || !this.cached.isStreaming) {
      return false;
    }
    await this.cached.abort();
    return true;
  }

  public clear(): Promise<void> {
    return this.enqueue(async () => {
      await this.tearDownCached();
      await this.patchSettings({ sessionPath: undefined });
    });
  }

  public setCwd(newCwd: string): Promise<SetCwdResult> {
    return this.enqueueResult(async (): Promise<SetCwdResult> => {
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
        return {
          ok: false,
          error: `stat failed: ${(err as Error).message}`,
        };
      }
      await this.tearDownCached();
      await this.patchSettings({ cwd: newCwd, sessionPath: undefined });
      return { ok: true };
    });
  }

  public setModel(pattern: string): Promise<SetModelResult> {
    return this.enqueueResult(async (): Promise<SetModelResult> => {
      const result = this.resolveModel(pattern);
      if (result.kind === "none" || result.kind === "ambiguous") {
        return {
          ok: false,
          kind: result.kind,
          candidates: result.candidates,
        };
      }
      const id = Session.modelId(result.model);
      if (this.currentSettings.model === id) {
        return { ok: true, id };
      }
      await this.patchSettings({ model: id });
      if (this.cached) {
        await this.cached.setModel(result.model);
      }
      return { ok: true, id };
    });
  }

  public setThinkingLevel(level: ThinkingLevelOpt): Promise<void> {
    return this.enqueue(async () => {
      if (this.currentSettings.thinkingLevel === level) {
        return;
      }
      await this.patchSettings({ thinkingLevel: level });
      if (this.cached) {
        this.cached.setThinkingLevel(level as ThinkingLevel);
      }
    });
  }

  public setLogsMode(mode: LogsMode): Promise<void> {
    return this.enqueue(async () => {
      if (this.currentSettings.logsMode === mode) {
        return;
      }
      await this.patchSettings({ logsMode: mode });
    });
  }

  public dispose(): void {
    if (this.cached) {
      this.cachedUnsubscribe?.();
      this.cached.dispose();
      this.cached = undefined;
      this.cachedUnsubscribe = undefined;
    }
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work);
    const tail = next.catch((err: unknown) => {
      console.error(`[session ${Session.encodeId(this.id)}] work failed:`, err);
    });
    this.queue = tail;
    this.lastUsed = Date.now();
    return next;
  }

  private enqueueResult<T>(work: () => Promise<T>): Promise<T> {
    let resolve!: (value: T) => void;
    let reject!: (err: unknown) => void;
    const result = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    void this.enqueue(async () => {
      try {
        resolve(await work());
      } catch (err) {
        reject(err);
      }
    });
    return result;
  }

  private async ensureCached(): Promise<AgentSession> {
    const wrapped = await this.loadWrappedThreadInstruction();
    if (this.cached) {
      if (this.cachedPromptInstruction !== wrapped) {
        this.cachedPromptInstruction = wrapped;
        await this.cached.reload();
      }
      return this.cached;
    }
    const sessionPath =
      this.currentSettings.sessionPath ?? this.defaultSessionPath();
    const { agent, cwd } = await this.buildAgent(sessionPath, wrapped);
    this.cached = agent;
    this.cachedPromptInstruction = wrapped;
    this.cachedLastTurnCost = agent.getSessionStats().cost ?? 0;
    this.cachedUnsubscribe = agent.subscribe((event) => {
      if (event.type !== "turn_end") {
        return;
      }
      const total = agent.getSessionStats().cost ?? 0;
      const delta = total - this.cachedLastTurnCost;
      if (delta <= 0) {
        return;
      }
      this.cachedLastTurnCost = total;
      void this.patchSettings({
        cumulativeCost: (this.currentSettings.cumulativeCost ?? 0) + delta,
      });
    });
    await this.patchSettings({ cwd, sessionPath });
    return agent;
  }

  private async buildIsolatedAgent(): Promise<AgentSession> {
    const sessionPath = this.isolatedSessionPath();
    await mkdir(dirname(sessionPath), { recursive: true });
    const wrapped = await this.loadWrappedThreadInstruction();
    const { agent } = await this.buildAgent(sessionPath, wrapped);
    return agent;
  }

  private async buildAgent(
    sessionPath: string,
    wrapped: string | undefined
  ): Promise<{ readonly agent: AgentSession; readonly cwd: string }> {
    const cwd = this.currentSettings.cwd ?? this.deps.config.cwd;
    const sessionManager = SessionManager.open(sessionPath, undefined, cwd);
    const settingsManager = this.deps.settingsManagerFor(cwd);
    const promptRef = { wrapped };
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: this.deps.agentDir,
      settingsManager,
      appendSystemPromptOverride: (base) => {
        return promptRef.wrapped ? [...base, promptRef.wrapped] : base;
      },
    });
    await loader.reload();

    const defaultModelId = this.currentSettings.model ?? this.deps.config.model;
    let model: Model<ModelApi> | undefined;
    if (defaultModelId) {
      const resolved = this.resolveModel(defaultModelId);
      if (resolved.kind === "ok") {
        model = resolved.model;
      } else {
        console.warn(
          `[session ${Session.encodeId(this.id)}] model "${defaultModelId}" did not resolve cleanly (${resolved.kind})`
        );
      }
    }

    const sendFile = SendFileTool.build({
      api: this.deps.api,
      sessionId: this.id,
      cwd,
    });
    const taskTool = TaskTool.build({
      scheduler: this.deps.scheduler,
      sessionId: this.id,
    });

    const { session: agent } = await createAgentSession({
      cwd,
      agentDir: this.deps.agentDir,
      authStorage: this.deps.authStorage,
      modelRegistry: this.deps.modelRegistry,
      settingsManager,
      resourceLoader: loader,
      sessionManager,
      model,
      thinkingLevel: this.currentSettings.thinkingLevel as
        | ThinkingLevel
        | undefined,
      customTools: [sendFile, taskTool],
    });

    return { agent, cwd };
  }

  private async tearDownCached(): Promise<void> {
    if (this.cached) {
      this.cachedUnsubscribe?.();
      this.cached.dispose();
      this.cached = undefined;
      this.cachedUnsubscribe = undefined;
      this.cachedPromptInstruction = undefined;
    }
    const path = this.currentSettings.sessionPath ?? this.defaultSessionPath();
    const archived = `${path}.archived-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      await rename(path, archived);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          `[session ${Session.encodeId(this.id)}] archive ${path}:`,
          err
        );
      }
    }
  }

  private async patchSettings(patch: Partial<SessionSettings>): Promise<void> {
    this.currentSettings = { ...this.currentSettings, ...patch };
    await this.deps.persistSettings(patch);
  }

  private defaultSessionPath(): string {
    return join(
      this.deps.config.configDir,
      "sessions",
      `${Session.encodeId(this.id)}.jsonl`
    );
  }

  private isolatedSessionPath(): string {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    return join(
      this.deps.config.configDir,
      "tasks-sessions",
      `${Session.encodeId(this.id)}-${ts}.jsonl`
    );
  }

  private threadInstructionPath(): string {
    return join(
      this.deps.config.configDir,
      "instructions",
      `${Session.encodeId(this.id)}.md`
    );
  }

  private async loadWrappedThreadInstruction(): Promise<string | undefined> {
    const path = this.threadInstructionPath();
    let userContent: string | undefined;
    try {
      userContent = (await Bun.file(path).text()).trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[thread-prompt] failed to read ${path}:`, err);
      }
    }
    const systemIx =
      "You are running as a Telegram bot powered by Pim Agent. The thread_user_instructions below are your editable per-thread system instructions; edit the file at its `path` attribute to update your instructions for this chat/thread.";
    const userIx = `<thread_user_instructions path="${path}">${userContent ? `\n${userContent}\n` : ""}</thread_user_instructions>`;
    return `<telegram_system_instructions>\n${systemIx}\n${userIx}\n</telegram_system_instructions>`;
  }

  private resolveDefaultModel(): Model<ModelApi> | undefined {
    const sessionModel = this.currentSettings.model;
    if (sessionModel) {
      const r = this.resolveModel(sessionModel);
      if (r.kind === "ok") {
        return r.model;
      }
    }
    const configModel = this.deps.config.model;
    if (configModel) {
      const r = this.resolveModel(configModel);
      if (r.kind === "ok") {
        return r.model;
      }
    }
    const cwd = this.currentSettings.cwd ?? this.deps.config.cwd;
    const sm = this.deps.settingsManagerFor(cwd);
    const provider = sm.getDefaultProvider();
    const modelId = sm.getDefaultModel();
    if (provider && modelId) {
      const m = this.deps.modelRegistry.find(provider, modelId);
      if (m) {
        return m;
      }
    }
    return this.deps.modelRegistry.getAvailable()[0];
  }

  private resolveModel(pattern: string): ModelResolveResult {
    const available = this.deps.modelRegistry.getAvailable();
    const candidates: FuzzyCandidate<Model<ModelApi>>[] = available.map(
      (m) => ({
        item: m,
        haystacks: [Session.modelId(m), m.id, m.name],
      })
    );

    const exact = available.find(
      (m) =>
        Session.modelId(m) === pattern.trim() ||
        m.id === pattern.trim() ||
        m.name === pattern.trim()
    );
    if (exact) {
      return { kind: "ok", model: exact };
    }

    const hits = FuzzyMatcher.rank(pattern, candidates, { limit: 5 });
    if (hits.length === 0) {
      return {
        kind: "none",
        candidates: available.slice(0, 8).map(Session.modelId),
      };
    }
    if (hits.length === 1) {
      return { kind: "ok", model: hits[0]!.item };
    }
    const top = hits[0]!;
    const second = hits[1]!;
    if (top.score > second.score * 1.5) {
      return { kind: "ok", model: top.item };
    }
    return {
      kind: "ambiguous",
      candidates: hits.map((h) => Session.modelId(h.item)),
    };
  }

  private static modelId(model: Model<ModelApi>): string {
    return `${model.provider}/${model.id}`;
  }
}
