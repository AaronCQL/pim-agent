import {
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Api as ModelApi, Model } from "@earendil-works/pi-ai";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { Directories } from "../shared/Directories";
import { EventLog } from "./EventLog";
import {
  SessionHost,
  type CustomToolContext,
  type HostSettings,
} from "./SessionHost";

const LRU_CAP = 16;

/** A session as pi stores it: one JSONL file under a cwd-encoded directory. */
export type SessionSummary = {
  readonly sessionId: string;
  readonly cwd: string;
  readonly path: string;
  readonly createdAt: number;
  readonly modifiedAt: number;
};

/** One model a session can be switched to, named the way `setModel` takes it. */
export type ModelChoice = {
  readonly id: string;
  readonly label: string;
  /** Who serves it, for a client that groups or tags the catalogue. */
  readonly provider: string;
};

export type SessionRegistryDeps = {
  readonly defaults: { readonly cwd: string; readonly model?: string };
  /** Where auth, models, settings and sessions live; must agree with pi's own `getAgentDir()`. */
  readonly agentDir?: string;
  readonly capacity?: number;
  readonly customTools?: (
    context: CustomToolContext
  ) => readonly ToolDefinition[];
  /** Appended to every session's system prompt. */
  readonly systemInstruction?: () => Promise<string | undefined>;
};

export type SessionCreateOptions = {
  readonly cwd?: string;
  /** Open the new session like this one: model, chosen thinking level, and cwd when none is given. */
  readonly like?: SessionHost;
};

/** Live sessions keyed on pi's session UUID; the catalogue is pi's sessions directory, read on demand. */
export class SessionRegistry {
  private readonly deps: SessionRegistryDeps;
  private readonly agentDir: string;
  private readonly capacity: number;
  private readonly hosts = new Map<string, SessionHost>();
  private readonly settingsManagers = new Map<string, SettingsManager>();
  private modelRuntime: ModelRuntime | undefined;
  private modelRegistry: ModelRegistry | undefined;

  public constructor(deps: SessionRegistryDeps) {
    this.deps = deps;
    this.agentDir = deps.agentDir ?? getAgentDir();
    this.capacity = deps.capacity ?? LRU_CAP;
  }

  public get sessionsRoot(): string {
    return join(this.agentDir, "sessions");
  }

  public async init(): Promise<void> {
    this.modelRuntime ??= await ModelRuntime.create({
      authPath: join(this.agentDir, "auth.json"),
      modelsPath: join(this.agentDir, "models.json"),
    });
    this.modelRegistry ??= new ModelRegistry(this.modelRuntime);
  }

  /** Sessions on disk, newest first; reads only each file's header line. */
  public async list(cwd?: string): Promise<readonly SessionSummary[]> {
    const root = this.sessionsRoot;
    if (!(await stat(root).catch(() => undefined))?.isDirectory()) {
      return [];
    }
    const paths: string[] = [];
    for await (const relative of new Bun.Glob("*/*.jsonl").scan({
      cwd: root,
      onlyFiles: true,
    })) {
      paths.push(join(root, relative));
    }
    const summaries = (await Promise.all(paths.map(readSummary))).filter(
      (summary): summary is SessionSummary =>
        summary !== undefined && (cwd === undefined || summary.cwd === cwd)
    );
    return summaries.sort((a, b) => b.modifiedAt - a.modifiedAt);
  }

  /** The live host for `sessionId`, if one is currently loaded. */
  public peek(sessionId: string): SessionHost | undefined {
    return this.hosts.get(sessionId);
  }

  /** Every model this machine has credentials for, qualified as `SessionHost.setModel` takes them. */
  public models(): readonly ModelChoice[] {
    const registry = this.modelRegistry;
    if (!registry) {
      throw new Error("SessionRegistry.init() must complete before use");
    }
    return registry.getAvailable().map((model: Model<ModelApi>) => ({
      id: `${model.provider}/${model.id}`,
      label: model.name,
      provider: model.provider,
    }));
  }

  public async open(sessionId: string): Promise<SessionHost> {
    const cached = this.hosts.get(sessionId);
    if (cached) {
      cached.lastUsed = Date.now();
      return cached;
    }
    const summary = (await this.list()).find((s) => s.sessionId === sessionId);
    if (!summary) {
      throw new Error(`unknown session: ${sessionId}`);
    }
    return this.adopt(
      sessionId,
      this.buildHost(sessionId, {
        cwd: summary.cwd,
        sessionPath: summary.path,
      })
    );
  }

  /** Start a new session; the agent is built eagerly because pi assigns the UUID and file. */
  public async create(
    options: SessionCreateOptions = {}
  ): Promise<SessionHost> {
    const like = options.like;
    const cwd = options.cwd ?? like?.cwd ?? this.deps.defaults.cwd;
    const reason = await Directories.check(cwd);
    if (reason !== undefined) {
      throw new Error(reason);
    }
    const model = like?.currentModelId;
    const thinkingLevel = like?.chosenThinkingLevel;
    const host = this.buildHost("pending", {
      cwd,
      ...(model === undefined ? {} : { model }),
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    });
    const agent = await host.ensureAgent();
    return this.adopt(agent.sessionId, host);
  }

  public async disposeAll(): Promise<void> {
    const hosts = [...this.hosts.values()];
    this.hosts.clear();
    await Promise.all(hosts.map((host) => host.dispose()));
  }

  private adopt(sessionId: string, host: SessionHost): SessionHost {
    this.evictIfNeeded();
    this.hosts.set(sessionId, host);
    return host;
  }

  private buildHost(label: string, settings: HostSettings): SessionHost {
    const modelRuntime = this.modelRuntime;
    const modelRegistry = this.modelRegistry;
    if (!modelRuntime || !modelRegistry) {
      throw new Error("SessionRegistry.init() must complete before use");
    }
    return new SessionHost({
      label: `session ${label}`,
      settings,
      defaults: this.deps.defaults,
      agentDir: this.agentDir,
      modelRuntime,
      modelRegistry,
      settingsManagerFor: (cwd) => this.settingsManagerFor(cwd),
      persistSettings: async () => {},
      customTools: this.deps.customTools,
      ...(this.deps.systemInstruction === undefined
        ? {}
        : { systemInstruction: this.deps.systemInstruction }),
    });
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
    if (this.hosts.size < this.capacity) {
      return;
    }
    let oldestKey: string | undefined;
    let oldest = Infinity;
    for (const [key, host] of this.hosts) {
      if (host.lastUsed < oldest) {
        oldest = host.lastUsed;
        oldestKey = key;
      }
    }
    if (!oldestKey) {
      return;
    }
    const evicted = this.hosts.get(oldestKey)!;
    this.hosts.delete(oldestKey);
    void evicted.dispose();
  }
}

async function readSummary(path: string): Promise<SessionSummary | undefined> {
  const header = await new EventLog(path).header();
  if (!header) {
    return undefined;
  }
  return {
    sessionId: header.id,
    cwd: header.cwd,
    path,
    createdAt: Date.parse(header.timestamp),
    modifiedAt: Math.floor((await Bun.file(path).stat()).mtimeMs),
  };
}
