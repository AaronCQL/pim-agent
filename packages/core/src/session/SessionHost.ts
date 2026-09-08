import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  Api as ModelApi,
  AssistantMessageEvent,
  Model,
} from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type CompactionResult,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { unlink } from "node:fs/promises";

import { CoreExtensions } from "../extensions/CoreExtensions";
import { Directories } from "../shared/Directories";
import { FuzzyMatcher, type FuzzyCandidate } from "../shared/FuzzyMatcher";
import { EventLog } from "./EventLog";

/** What the agent is doing right now. */
export type SessionStatus = "idle" | "thinking" | "streaming" | "tool";

/** Everything the host persists about a session; frontend-specific settings stay with the adapter. */
export type HostSettings = {
  readonly cwd?: string;
  readonly model?: string;
  readonly thinkingLevel?: ThinkingLevel;
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

export type SessionCompactResult = {
  readonly compaction: CompactionResult;
  readonly activeMessages: number;
};

/** What a `cancel` did; `restored` messages are the caller's from here on. */
export type CancelResult = {
  readonly cancelled: boolean;
  readonly restored: readonly string[];
};

export type SessionHostDeps = {
  /** Prefix for this host's log lines; also the registry key in practice. */
  readonly label: string;
  readonly settings: HostSettings;
  readonly defaults: { readonly cwd: string; readonly model?: string };
  readonly agentDir: string;
  readonly modelRuntime: ModelRuntime;
  readonly modelRegistry: ModelRegistry;
  readonly settingsManagerFor: (cwd: string) => SettingsManager;
  readonly persistSettings: (patch: Partial<HostSettings>) => Promise<void>;
  /** Omit to let pi place the file in its own cwd-grouped sessions directory. */
  readonly mainSessionPath?: () => string;
  readonly isolatedSessionPath?: () => string;
  readonly systemInstruction?: () => Promise<string | undefined>;
  readonly customTools?: (
    context: CustomToolContext
  ) => readonly ToolDefinition[];
  /** Runs after the agent is disposed, before the session file is forgotten. */
  readonly onRetire?: (sessionPath: string) => Promise<void>;
};

/** What a frontend's own tools are built against. */
export type CustomToolContext = {
  /** Where this session's tools resolve relative paths. */
  readonly cwd: string;
  /** Pi's session uuid, undefined until the agent exists. */
  readonly sessionId: () => string | undefined;
};

type ModelResolveResult =
  | { readonly kind: "ok"; readonly model: Model<ModelApi> }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] }
  | { readonly kind: "none"; readonly candidates: readonly string[] };

function isOutput(event: AssistantMessageEvent): boolean {
  switch (event.type) {
    case "text_delta":
    case "toolcall_delta":
      return event.delta.length > 0;
    case "text_end":
      return event.content.length > 0;
    default:
      return false;
  }
}

/** Owns one in-process `createAgentSession()`, its settings and a serialized turn queue. */
export class SessionHost {
  public readonly label: string;
  public lastUsed = Date.now();
  private readonly deps: SessionHostDeps;
  private currentSettings: HostSettings;
  private cached: AgentSession | undefined;
  private cachedUnsubscribe: (() => void) | undefined;
  private cachedSystemInstruction: string | undefined;
  private cachedLog: EventLog | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private runningTools = 0;
  private streaming = false;
  private producing = false;
  private outputStartedAt: number | undefined;
  private lastTps: number | undefined;

  public constructor(deps: SessionHostDeps) {
    this.deps = deps;
    this.label = deps.label;
    this.currentSettings = deps.settings;
  }

  public get settings(): HostSettings {
    return this.currentSettings;
  }

  public get agentDir(): string {
    return this.deps.agentDir;
  }

  public get cwd(): string {
    return this.currentSettings.cwd ?? this.deps.defaults.cwd;
  }

  public get agentSession(): AgentSession | undefined {
    return this.cached;
  }

  public get sessionId(): string | undefined {
    return this.cached?.sessionId;
  }

  /** Reader over this session's JSONL, live only once the agent is built. */
  public get eventLog(): EventLog | undefined {
    return this.cachedLog;
  }

  public get isStreaming(): boolean {
    return this.cached?.isStreaming ?? false;
  }

  public get status(): SessionStatus {
    if (this.runningTools > 0) {
      return "tool";
    }
    if (this.producing) {
      return "streaming";
    }
    if (this.streaming) {
      return "thinking";
    }
    return "idle";
  }

  /** Decode tokens per second for the last completed assistant message. */
  public get tps(): number | undefined {
    return this.lastTps;
  }

  public usage(): ReturnType<AgentSession["getContextUsage"]> | undefined {
    return this.cached?.getContextUsage();
  }

  public sessionCost(): number | undefined {
    const agent = this.cached;
    return agent ? (agent.getSessionStats().cost ?? 0) : undefined;
  }

  public get currentModelId(): string | undefined {
    const model = this.cached?.model ?? this.resolveDefaultModel();
    return model ? qualifiedModelId(model) : undefined;
  }

  /** The model's display name — "Claude Opus 5.0", not `anthropic/claude-opus-5`. */
  public get currentModelLabel(): string | undefined {
    return (this.cached?.model ?? this.resolveDefaultModel())?.name;
  }

  public get supportedThinkingLevels(): readonly ThinkingLevel[] {
    const model = this.cached?.model ?? this.resolveDefaultModel();
    return model ? getSupportedThinkingLevels(model) : [];
  }

  public get currentThinkingLevel(): ThinkingLevel {
    const chosen = this.chosenThinkingLevel;
    if (chosen) {
      return chosen;
    }
    const sm = this.deps.settingsManagerFor(this.cwd);
    return (sm.getDefaultThinkingLevel() as ThinkingLevel) ?? "medium";
  }

  /** The level this session was told to think at, absent when only its directory has a default. */
  public get chosenThinkingLevel(): ThinkingLevel | undefined {
    return this.currentSettings.thinkingLevel ?? this.cached?.thinkingLevel;
  }

  /** Run `work` as a turn, serialized in submission order; `isolated` uses a throwaway agent and file. */
  public run(
    work: (agent: AgentSession) => Promise<void>,
    opts?: { readonly isolated?: boolean }
  ): Promise<void> {
    return this.enqueue(async () => {
      if (opts?.isolated) {
        const { agent, sessionPath } = await this.buildIsolatedAgent();
        try {
          await work(agent);
        } finally {
          await disposeAgent(agent);
          await unlink(sessionPath).catch((err: unknown) => {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
              console.warn(`[${this.label}] unlink ${sessionPath}:`, err);
            }
          });
        }
        return;
      }
      const agent = await this.ensureCached();
      await work(agent);
    });
  }

  /** Build or reuse the cached agent inside the turn queue; its id and file exist once this resolves. */
  public ensureAgent(): Promise<AgentSession> {
    return this.enqueue(() => this.ensureCached());
  }

  /** Run `work` in this session's turn queue without touching the agent. */
  public serialize<T>(work: () => Promise<T>): Promise<T> {
    return this.enqueue(work);
  }

  /** Stop the turn in flight; empty the queue before aborting or pi delivers it to the next turn. */
  public async cancel(): Promise<CancelResult> {
    if (!this.cached || !this.cached.isStreaming) {
      return { cancelled: false, restored: [] };
    }
    const restored = this.takeBack();
    await this.cached.abort();
    return { cancelled: true, restored };
  }

  /** Take back every message queued behind the running turn; not serialized, the turn holds the queue. */
  public takeBack(): readonly string[] {
    if (!this.cached || !this.cached.isStreaming) {
      return [];
    }
    const { steering, followUp } = this.cached.clearQueue();
    return [...steering, ...followUp];
  }

  public clear(): Promise<void> {
    return this.enqueue(async () => {
      await this.tearDownCached();
      await this.patchSettings({ sessionPath: undefined });
    });
  }

  public setCwd(newCwd: string): Promise<SetCwdResult> {
    return this.enqueue(async (): Promise<SetCwdResult> => {
      const reason = await Directories.check(newCwd);
      if (reason !== undefined) {
        return { ok: false, error: reason };
      }
      await this.tearDownCached();
      await this.patchSettings({ cwd: newCwd, sessionPath: undefined });
      return { ok: true };
    });
  }

  public setModel(pattern: string): Promise<SetModelResult> {
    return this.enqueue(async (): Promise<SetModelResult> => {
      const result = this.resolveModel(pattern);
      if (result.kind === "none" || result.kind === "ambiguous") {
        return { ok: false, kind: result.kind, candidates: result.candidates };
      }
      const id = qualifiedModelId(result.model);
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

  public setThinkingLevel(level: ThinkingLevel): Promise<void> {
    return this.enqueue(async () => {
      if (this.currentSettings.thinkingLevel === level) {
        return;
      }
      await this.patchSettings({ thinkingLevel: level });
      this.cached?.setThinkingLevel(level);
    });
  }

  public compact(customInstructions?: string): Promise<SessionCompactResult> {
    return this.enqueue(async (): Promise<SessionCompactResult> => {
      const agent = await this.ensureCached();
      const compaction = await agent.compact(customInstructions);
      return { compaction, activeMessages: agent.messages.length };
    });
  }

  public async dispose(): Promise<void> {
    if (this.cached) {
      const agent = this.cached;
      this.detachCached();
      await disposeAgent(agent);
    }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    // Only the stored tail swallows: the chain must never reject, callers still see their own failure.
    this.queue = next.catch((err: unknown) => {
      console.error(`[${this.label}] work failed:`, err);
    });
    this.lastUsed = Date.now();
    return next;
  }

  private async ensureCached(): Promise<AgentSession> {
    const systemInstruction = await this.deps.systemInstruction?.();
    if (this.cached) {
      if (this.cachedSystemInstruction !== systemInstruction) {
        this.cachedSystemInstruction = systemInstruction;
        await this.cached.reload();
      }
      return this.cached;
    }
    const { agent, cwd } = await this.buildAgent(
      this.currentSettings.sessionPath ?? this.deps.mainSessionPath?.(),
      systemInstruction
    );
    this.cached = agent;
    this.cachedSystemInstruction = systemInstruction;
    this.cachedLog = agent.sessionFile
      ? new EventLog(agent.sessionFile)
      : undefined;
    this.cachedUnsubscribe = this.observe(agent);
    await this.patchSettings({ cwd, sessionPath: agent.sessionFile });
    return agent;
  }

  private observe(agent: AgentSession): () => void {
    const stopCostTracking = this.observeCost(agent);
    const stop = agent.subscribe((event: AgentSessionEvent) => {
      switch (event.type) {
        case "agent_start":
          this.streaming = true;
          this.producing = false;
          this.outputStartedAt = undefined;
          break;
        case "message_start":
          this.producing = false;
          this.outputStartedAt = undefined;
          break;
        case "message_update":
          if (
            event.message.role === "assistant" &&
            isOutput(event.assistantMessageEvent)
          ) {
            this.producing = true;
            this.outputStartedAt ??= Date.now();
          }
          break;
        case "message_end":
          if (event.message.role === "assistant") {
            this.recordTps(event.message.usage?.output ?? 0);
          }
          this.producing = false;
          break;
        case "tool_execution_start":
          this.runningTools += 1;
          break;
        case "tool_execution_end":
          this.runningTools = Math.max(0, this.runningTools - 1);
          break;
        case "agent_settled":
          this.streaming = false;
          this.producing = false;
          this.runningTools = 0;
          break;
      }
    });
    return () => {
      stop();
      stopCostTracking();
    };
  }

  private observeCost(agent: AgentSession): () => void {
    let last = agent.getSessionStats().cost ?? 0;
    return agent.subscribe((event) => {
      if (event.type !== "turn_end") {
        return;
      }
      const total = agent.getSessionStats().cost ?? 0;
      const delta = total - last;
      if (delta <= 0) {
        return;
      }
      last = total;
      void this.patchSettings({
        cumulativeCost: (this.currentSettings.cumulativeCost ?? 0) + delta,
      });
    });
  }

  private recordTps(outputTokens: number): void {
    const startedAt = this.outputStartedAt;
    this.outputStartedAt = undefined;
    const elapsed = startedAt === undefined ? 0 : Date.now() - startedAt;
    if (outputTokens > 0 && elapsed > 0) {
      this.lastTps = (outputTokens * 1000) / elapsed;
    }
  }

  private async buildIsolatedAgent(): Promise<{
    readonly agent: AgentSession;
    readonly sessionPath: string;
  }> {
    const sessionPath = this.deps.isolatedSessionPath?.();
    if (!sessionPath) {
      throw new Error(`[${this.label}] isolated runs need isolatedSessionPath`);
    }
    const { agent } = await this.buildAgent(
      sessionPath,
      await this.deps.systemInstruction?.()
    );
    this.observeCost(agent);
    return { agent, sessionPath };
  }

  private async buildAgent(
    sessionPath: string | undefined,
    wrapped: string | undefined
  ): Promise<{ readonly agent: AgentSession; readonly cwd: string }> {
    const cwd = this.cwd;
    const sessionManager = sessionPath
      ? SessionManager.open(sessionPath, undefined, cwd)
      : SessionManager.create(cwd);
    const settingsManager = this.deps.settingsManagerFor(cwd);
    const promptRef = { wrapped };
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: this.deps.agentDir,
      settingsManager,
      // Load core tools in-process: a disk-loaded copy registers views into a second `Tools`.
      extensionFactories: CoreExtensions.gated(),
      appendSystemPromptOverride: (base) => {
        return promptRef.wrapped ? [...base, promptRef.wrapped] : base;
      },
    });
    await loader.reload();

    const defaultModelId =
      this.currentSettings.model ?? this.deps.defaults.model;
    let model: Model<ModelApi> | undefined;
    if (defaultModelId) {
      const resolved = this.resolveModel(defaultModelId);
      if (resolved.kind === "ok") {
        model = resolved.model;
      } else {
        console.warn(
          `[${this.label}] model "${defaultModelId}" did not resolve cleanly (${resolved.kind})`
        );
      }
    }

    const { session: agent } = await createAgentSession({
      cwd,
      agentDir: this.deps.agentDir,
      modelRuntime: this.deps.modelRuntime,
      settingsManager,
      resourceLoader: loader,
      sessionManager,
      model,
      thinkingLevel: this.currentSettings.thinkingLevel,
      customTools: [
        ...(this.deps.customTools?.({
          cwd,
          sessionId: () => this.sessionId,
        }) ?? []),
      ],
    });

    // Emits session_start; without it extension tools are registered but never usable.
    await agent.bindExtensions({
      mode: "print",
      onError: (err) => {
        console.warn(
          `[${this.label}] extension ${err.extensionPath} (${err.event}):`,
          err.error
        );
      },
    });

    return { agent, cwd };
  }

  private detachCached(): void {
    this.cachedUnsubscribe?.();
    this.cached = undefined;
    this.cachedUnsubscribe = undefined;
    this.cachedLog = undefined;
    this.runningTools = 0;
    this.streaming = false;
    this.producing = false;
  }

  private async tearDownCached(): Promise<void> {
    if (this.cached) {
      const agent = this.cached;
      this.detachCached();
      this.cachedSystemInstruction = undefined;
      await disposeAgent(agent);
    }
    const path =
      this.currentSettings.sessionPath ?? this.deps.mainSessionPath?.();
    if (path) {
      await this.deps.onRetire?.(path);
    }
  }

  private async patchSettings(patch: Partial<HostSettings>): Promise<void> {
    this.currentSettings = { ...this.currentSettings, ...patch };
    await this.deps.persistSettings(patch);
  }

  private resolveDefaultModel(): Model<ModelApi> | undefined {
    this.deps.modelRegistry.refresh();
    for (const candidate of [
      this.currentSettings.model,
      this.deps.defaults.model,
    ]) {
      if (candidate) {
        const r = this.resolveModel(candidate);
        if (r.kind === "ok") {
          return r.model;
        }
      }
    }
    const sm = this.deps.settingsManagerFor(this.cwd);
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
    this.deps.modelRegistry.refresh();
    const available = this.deps.modelRegistry.getAvailable();
    const candidates: FuzzyCandidate<Model<ModelApi>>[] = available.map(
      (m) => ({
        item: m,
        haystacks: [qualifiedModelId(m), m.id, m.name],
      })
    );

    const exact = available.find(
      (m) =>
        qualifiedModelId(m) === pattern.trim() ||
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
        candidates: available.slice(0, 8).map(qualifiedModelId),
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
      candidates: hits.map((h) => qualifiedModelId(h.item)),
    };
  }
}

function qualifiedModelId(model: Model<ModelApi>): string {
  return `${model.provider}/${model.id}`;
}

async function disposeAgent(agent: AgentSession): Promise<void> {
  try {
    await agent.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
  } catch (err) {
    console.warn(`[session] extension shutdown failed:`, err);
  }
  agent.dispose();
}
