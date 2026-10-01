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
  type ExtensionError,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { unlink } from "node:fs/promises";

import { CoreExtensions } from "../extensions/CoreExtensions";
import { Directories } from "../shared/Directories";
import { FuzzyMatcher, type FuzzyCandidate } from "../shared/FuzzyMatcher";
import type { Surface } from "../shared/Surface";
import { EventLog } from "./EventLog";
import {
  SessionLease,
  type LeaseFrontend,
  type LeaseRecord,
} from "./SessionLease";
import { SessionName } from "./SessionName";
import { adaptSessionUi, type SessionUi } from "./SessionUi";
import { WriteMark } from "./WriteMark";

export type SessionStatus = "idle" | "thinking" | "streaming" | "tool";

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

/** `restored` are the queued messages taken back from pi. */
export type CancelResult = {
  readonly cancelled: boolean;
  readonly restored: readonly string[];
};

export type LeaseState = {
  readonly writable: boolean;
  readonly heldBy?: {
    readonly frontend: LeaseFrontend;
    readonly pid: number;
  };
};

export type SessionHostDeps = {
  /** Log prefix. */
  readonly label: string;
  readonly settings: HostSettings;
  readonly defaults: { readonly cwd: string; readonly model?: string };
  readonly agentDir: string;
  readonly modelRuntime: ModelRuntime;
  readonly modelRegistry: ModelRegistry;
  readonly settingsManagerFor: (cwd: string) => SettingsManager;
  readonly persistSettings: (patch: Partial<HostSettings>) => Promise<void>;
  /** Takes the turn lease around every mutation. Omit when no other process can open the file. */
  readonly lease?: LeaseFrontend;
  /** Omit to let pi choose the file path. */
  readonly mainSessionPath?: () => string;
  readonly isolatedSessionPath?: () => string;
  readonly systemInstruction?: () => Promise<string | undefined>;
  readonly surface?: Surface;
  readonly customTools?: (
    context: CustomToolContext
  ) => readonly ToolDefinition[];
  /** Runs after the agent is disposed, before `sessionPath` is cleared. */
  readonly onRetire?: (sessionPath: string) => Promise<void>;
  /** Extension UI sink, read per call. Omit for pi's no-op UI; pi fixes the mode at bind time. */
  readonly ui?: () => SessionUi | undefined;
};

export type CustomToolContext = {
  readonly cwd: string;
  /** Undefined until the agent exists. */
  readonly sessionId: () => string | undefined;
};

type ModelResolveResult =
  | { readonly kind: "ok"; readonly model: Model<ModelApi> }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] }
  | { readonly kind: "none"; readonly candidates: readonly string[] };

/** `holder` is absent when the lease file is unreadable. */
type LeaseWait = { readonly holder?: LeaseRecord };

const FOREIGN_POLL_MS = 2_000;

function sameWait(a: LeaseWait | undefined, b: LeaseWait | undefined): boolean {
  return a === undefined || b === undefined
    ? a === b
    : a.holder?.pid === b.holder?.pid &&
        a.holder?.startedAt === b.holder?.startedAt;
}

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

/** One in-process pi agent session, its settings and a serialized turn queue. */
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
  private seqLog: EventLog | undefined;
  /** File head after this host's last write. */
  private lastSeen: { readonly path: string; readonly seq: number } | undefined;
  private blockedBy: LeaseWait | undefined;
  private readonly leaseListeners = new Set<() => void>();
  private readonly foreignListeners = new Set<() => void>();
  /** Set only while a held turn is watching for foreign writes. */
  private sampleWrites: (() => Promise<void>) | undefined;
  private readonly agentListeners = new Set<
    (event: AgentSessionEvent) => void
  >();
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

  /** Undefined until the agent is built. */
  public get eventLog(): EventLog | undefined {
    return this.cachedLog;
  }

  /** Not writable only while one of our mutations waits on another process's lease. */
  public get leaseState(): LeaseState {
    const blocked = this.blockedBy;
    if (blocked === undefined) {
      return { writable: true };
    }
    const holder = blocked.holder;
    return holder === undefined
      ? { writable: false }
      : {
          writable: false,
          heldBy: { frontend: holder.frontend, pid: holder.pid },
        };
  }

  /** Fires whenever `leaseState` changes. */
  public onLeaseChange(listener: () => void): () => void {
    this.leaseListeners.add(listener);
    return () => {
      this.leaseListeners.delete(listener);
    };
  }

  /** Fires at most once per turn in which another process appended to the file. */
  public onForeignWrite(listener: () => void): () => void {
    this.foreignListeners.add(listener);
    return () => {
      this.foreignListeners.delete(listener);
    };
  }

  /** Survives agent rebuilds. */
  public subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.agentListeners.add(listener);
    return () => {
      this.agentListeners.delete(listener);
    };
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
    const model = this.currentModel();
    return model ? qualifiedModelId(model) : undefined;
  }

  /** Display name, e.g. "Claude Opus 5.0". */
  public get currentModelLabel(): string | undefined {
    return this.currentModel()?.name;
  }

  public get supportedThinkingLevels(): readonly ThinkingLevel[] {
    const model = this.currentModel();
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

  /** Undefined when only the directory's default applies. */
  public get chosenThinkingLevel(): ThinkingLevel | undefined {
    return this.currentSettings.thinkingLevel ?? this.cached?.thinkingLevel;
  }

  /** Runs `work` as a queued turn. `isolated` uses a throwaway agent and file, without the lease. */
  public run(
    work: (agent: AgentSession) => Promise<void>,
    opts?: { readonly isolated?: boolean }
  ): Promise<void> {
    if (opts?.isolated) {
      return this.enqueue(async () => {
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
      });
    }
    return this.withLease(async () => {
      const agent = await this.ensureCached();
      await work(agent);
    });
  }

  /** Builds or reuses the agent inside the turn queue. */
  public ensureAgent(): Promise<AgentSession> {
    return this.enqueue(() => this.ensureCached());
  }

  /** Runs `work` in the turn queue without touching the agent. */
  public serialize<T>(work: () => Promise<T>): Promise<T> {
    return this.enqueue(work);
  }

  /** Aborts the running turn and takes back its queued messages. */
  public async cancel(): Promise<CancelResult> {
    if (!this.cached || !this.cached.isStreaming) {
      return { cancelled: false, restored: [] };
    }
    // Before aborting, or pi delivers the queue to the next turn.
    const restored = this.takeBack();
    await this.cached.abort();
    return { cancelled: true, restored };
  }

  /** Takes back messages queued behind the running turn. Not queued: the turn holds the queue. */
  public takeBack(): readonly string[] {
    if (!this.cached || !this.cached.isStreaming) {
      return [];
    }
    const { steering, followUp } = this.cached.clearQueue();
    return [...steering, ...followUp];
  }

  public clear(): Promise<void> {
    return this.withLease(async () => {
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
    return this.withLease(async (): Promise<SetModelResult> => {
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
    return this.withLease(async () => {
      if (this.currentSettings.thinkingLevel === level) {
        return;
      }
      await this.patchSettings({ thinkingLevel: level });
      this.cached?.setThinkingLevel(level);
    });
  }

  /** Sets pi's session name; `null` clears it. Returns the stored name. */
  public setName(name: string | null): Promise<string | undefined> {
    return this.withLease(async () => {
      const agent = await this.ensureCached();
      agent.setSessionName(SessionName.normalise(name));
      return agent.sessionManager.getSessionName();
    });
  }

  public compact(customInstructions?: string): Promise<SessionCompactResult> {
    return this.withLease(async (): Promise<SessionCompactResult> => {
      const agent = await this.ensureCached();
      const compaction = await agent.compact(customInstructions);
      return { compaction, activeMessages: agent.messages.length };
    });
  }

  /** Drops the agent so the next turn rebuilds it from the file. */
  public async invalidate(): Promise<void> {
    if (!this.cached) {
      return;
    }
    const agent = this.cached;
    this.detachCached();
    this.cachedSystemInstruction = undefined;
    await disposeAgent(agent);
  }

  public async dispose(): Promise<void> {
    await this.invalidate();
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    // Keep the chain alive; callers still get their own rejection.
    this.queue = next.catch((err: unknown) => {
      console.error(`[${this.label}] work failed:`, err);
    });
    this.lastUsed = Date.now();
    return next;
  }

  private get leasePath(): string | undefined {
    return (
      this.cached?.sessionFile ??
      this.currentSettings.sessionPath ??
      this.deps.mainSessionPath?.()
    );
  }

  /** Queues `work` under the turn lease, rehydrating before and after waiting for it. */
  private withLease<T>(work: () => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const frontend = this.deps.lease;
      if (frontend === undefined) {
        return await work();
      }
      await this.rehydrateIfStale();
      // A new session's path is only known once pi builds the agent.
      const path = this.leasePath ?? (await this.ensureCached()).sessionFile;
      if (path === undefined) {
        return await work();
      }
      try {
        return await SessionLease.hold(
          path,
          frontend,
          async () => {
            this.setBlocked(undefined);
            await this.rehydrateIfStale();
            const settle = await this.watchForeignWrites(path);
            try {
              return await work();
            } finally {
              // After a foreign write, leave `lastSeen` stale so the next turn rebuilds.
              if (!(await settle())) {
                await this.markSeen(path);
              }
            }
          },
          {
            onBlocked: (holder) =>
              this.setBlocked(holder === undefined ? {} : { holder }),
          }
        );
      } finally {
        this.setBlocked(undefined);
      }
    });
  }

  /**
   * Polls for lines another process appended during a held turn. Warns at most
   * once and never aborts. The returned stop function resolves to whether any landed.
   */
  private async watchForeignWrites(
    path: string
  ): Promise<() => Promise<boolean>> {
    let base:
      | { readonly agent: AgentSession; readonly mark: WriteMark }
      | undefined;
    let foreign = false;

    const check = async (): Promise<void> => {
      if (foreign) {
        return;
      }
      const agent = this.cached;
      // A rebuilt agent may have rewritten the file, so restart accounting from it.
      if (agent?.sessionFile !== path) {
        base = undefined;
        return;
      }
      const mark = await WriteMark.of(this.logFor(path), agent.sessionManager);
      const previous = base;
      base = { agent, mark };
      if (
        previous?.agent !== agent ||
        !WriteMark.foreignSince(previous.mark, mark)
      ) {
        return;
      }
      foreign = true;
      console.warn(
        `[${this.label}] ${path} was written by another process during this turn; its history may be inconsistent`
      );
      for (const listener of this.foreignListeners) {
        listener();
      }
    };

    const sample = (): Promise<void> => check().catch(() => undefined);
    this.sampleWrites = sample;
    await sample();
    const timer = setInterval(() => void sample(), FOREIGN_POLL_MS);
    timer.unref?.();

    return async (): Promise<boolean> => {
      clearInterval(timer);
      this.sampleWrites = undefined;
      await sample();
      return foreign;
    };
  }

  private setBlocked(blocked: LeaseWait | undefined): void {
    if (sameWait(this.blockedBy, blocked)) {
      return;
    }
    this.blockedBy = blocked;
    for (const listener of this.leaseListeners) {
      listener();
    }
  }

  /** Drops the agent if the file grew since our last write. */
  private async rehydrateIfStale(): Promise<void> {
    const path = this.cached?.sessionFile;
    const seen = this.lastSeen;
    if (path === undefined || seen?.path !== path) {
      return;
    }
    if ((await this.logFor(path).head()) > seen.seq) {
      await this.invalidate();
    }
  }

  private async markSeen(path: string): Promise<void> {
    this.lastSeen = { path, seq: await this.logFor(path).head() };
  }

  private logFor(path: string): EventLog {
    if (this.seqLog?.path !== path) {
      this.seqLog = new EventLog(path);
    }
    return this.seqLog;
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
    if (this.deps.lease !== undefined && agent.sessionFile) {
      await this.markSeen(agent.sessionFile);
    }
    // Re-anchor a watching turn on the new agent.
    await this.sampleWrites?.();
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
      for (const listener of this.agentListeners) {
        listener(event);
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
      // In-process: a disk-loaded copy would register views into a second `Tools`.
      extensionFactories: CoreExtensions.gated(this.deps.surface),
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

    const onError = (err: ExtensionError) => {
      console.warn(
        `[${this.label}] extension ${err.extensionPath} (${err.event}):`,
        err.error
      );
      // Pi treats a throwing command as success, so tell the user.
      this.deps
        .ui?.()
        ?.notify(
          `${err.extensionPath} (${err.event}) failed: ${err.error}`,
          "error"
        );
    };
    const ui = this.deps.ui;
    // Emits session_start; extension tools are unusable without it.
    await agent.bindExtensions(
      ui
        ? // Any uiContext makes pi's `hasUI()` true; "rpc" means dialogs but no terminal.
          {
            uiContext: adaptSessionUi(ui),
            mode: "rpc",
            onError,
          }
        : { mode: "print", onError }
    );

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
    await this.invalidate();
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

  private currentModel(): Model<ModelApi> | undefined {
    return this.cached?.model ?? this.resolveDefaultModel();
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
    const wanted = pattern.trim();
    const exact = available.find(
      (m) =>
        qualifiedModelId(m) === wanted || m.id === wanted || m.name === wanted
    );
    if (exact) {
      return { kind: "ok", model: exact };
    }

    const candidates: FuzzyCandidate<Model<ModelApi>>[] = available.map(
      (m) => ({
        item: m,
        haystacks: [qualifiedModelId(m), m.id, m.name],
      })
    );
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
