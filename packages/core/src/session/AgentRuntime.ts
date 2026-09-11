import type { Api as ModelApi, Model } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

/** One model a session can be switched to, named the way `setModel` takes it. */
export type ModelChoice = {
  readonly id: string;
  readonly label: string;
  /** Who serves it, for a client that groups or tags the catalogue. */
  readonly provider: string;
};

/**
 * Pi's installation as one process sees it: a single `ModelRuntime` over a
 * single `auth.json`, and one `SettingsManager` per cwd. Every surface in a
 * process shares one of these — two runtimes over one auth file race each
 * other's token refresh.
 */
export class AgentRuntime {
  public readonly agentDir: string;
  private readonly settingsManagers = new Map<string, SettingsManager>();
  private runtime: ModelRuntime | undefined;
  private registry: ModelRegistry | undefined;
  private booting: Promise<void> | undefined;

  public constructor(agentDir?: string) {
    this.agentDir = agentDir ?? getAgentDir();
  }

  /** Idempotent, and shared by every caller: the second surface to ask waits on the first. */
  public init(): Promise<void> {
    this.booting ??= this.bootstrap().catch((err: unknown) => {
      this.booting = undefined;
      throw err;
    });
    return this.booting;
  }

  public get modelRuntime(): ModelRuntime {
    return this.required(this.runtime);
  }

  public get modelRegistry(): ModelRegistry {
    return this.required(this.registry);
  }

  /** Every model this machine has credentials for, qualified as `setModel` takes them. */
  public models(): readonly ModelChoice[] {
    return this.modelRegistry.getAvailable().map((model: Model<ModelApi>) => ({
      id: `${model.provider}/${model.id}`,
      label: model.name,
      provider: model.provider,
    }));
  }

  public settingsManagerFor(cwd: string): SettingsManager {
    const existing = this.settingsManagers.get(cwd);
    if (existing) {
      return existing;
    }
    const settingsManager = SettingsManager.create(cwd, this.agentDir);
    this.settingsManagers.set(cwd, settingsManager);
    return settingsManager;
  }

  private async bootstrap(): Promise<void> {
    this.runtime = await ModelRuntime.create({
      authPath: join(this.agentDir, "auth.json"),
      modelsPath: join(this.agentDir, "models.json"),
    });
    this.registry = new ModelRegistry(this.runtime);
  }

  private required<T>(value: T | undefined): T {
    if (value === undefined) {
      throw new Error("AgentRuntime.init() must complete before use");
    }
    return value;
  }
}
