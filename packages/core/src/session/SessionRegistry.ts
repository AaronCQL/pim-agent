import {
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { EventLog } from "./EventLog";
import { SessionHost, type HostSettings } from "./SessionHost";

const LRU_CAP = 16;

/** A session as pi stores it: one JSONL file under a cwd-encoded directory. */
export type SessionSummary = {
  readonly sessionId: string;
  readonly cwd: string;
  readonly path: string;
  readonly createdAt: number;
  readonly modifiedAt: number;
};

export type SessionRegistryDeps = {
  readonly defaults: { readonly cwd: string; readonly model?: string };
  /**
   * Where auth, models, settings, and sessions live. Must agree with pi's own
   * `getAgentDir()` — pi resolves the directory for a *new* session itself, and
   * only `PI_CODING_AGENT_DIR` moves it.
   */
  readonly agentDir?: string;
  readonly capacity?: number;
  readonly customTools?: (cwd: string) => readonly ToolDefinition[];
};

/**
 * Keys live sessions on pi's own session UUID — never a chat id, never a cwd. The catalogue is pi's sessions directory itself, read
 * on demand; there is no metadata store, index, or cache of our own, so a
 * session created by the TUI shows up here with no synchronisation at all.
 */
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

  /**
   * Sessions on disk, newest first. Reads only each file's header line, so
   * listing stays cheap no matter how long the conversations are.
   */
  public async list(cwd?: string): Promise<readonly SessionSummary[]> {
    const root = this.sessionsRoot;
    if (!(await stat(root).catch(() => undefined))?.isDirectory()) {
      return [];
    }
    const summaries: SessionSummary[] = [];
    for await (const relative of new Bun.Glob("*/*.jsonl").scan({
      cwd: root,
      onlyFiles: true,
    })) {
      const path = join(root, relative);
      const summary = await readSummary(path);
      if (summary && (cwd === undefined || summary.cwd === cwd)) {
        summaries.push(summary);
      }
    }
    return summaries.sort((a, b) => b.modifiedAt - a.modifiedAt);
  }

  /** The live host for `sessionId`, if one is currently loaded. */
  public peek(sessionId: string): SessionHost | undefined {
    return this.hosts.get(sessionId);
  }

  /** Resume an existing session by pi's UUID. */
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

  /**
   * Start a new session. Pi assigns the UUID and picks the file name inside its
   * own cwd-encoded directory, so the agent is built eagerly — the identity
   * does not exist before it does.
   */
  public async create(cwd?: string): Promise<SessionHost> {
    const host = this.buildHost("pending", {
      cwd: cwd ?? this.deps.defaults.cwd,
    });
    await host.run(async () => {});
    const sessionId = host.sessionId;
    if (!sessionId) {
      await host.dispose();
      throw new Error("pi did not assign a session id");
    }
    return this.adopt(sessionId, host);
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
      // Pi's JSONL is the only store; nothing here needs a second one.
      persistSettings: async () => {},
      customTools: this.deps.customTools,
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
    modifiedAt: Bun.file(path).lastModified,
  };
}
