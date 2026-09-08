import { type AgentSession, loadSkills } from "@earendil-works/pi-coding-agent";

import { loadRelative } from "./catalog";
import { rankCommands } from "./commandRanker";
import { InProcessFilePickerSuggestionEngine } from "./InProcessFilePickerSuggestionEngine";
import type { PickerItem } from "./PickerItem";

export type PickerServiceDeps = {
  /** Read per query: a session's cwd can move between turns. */
  readonly cwd: () => string;
  readonly agentDir: string;
  /** Extension-registered commands, available only while an agent is built. */
  readonly agent?: () => AgentSession | undefined;
};

const DEFAULT_LIMIT = 50;

/** Answers one session's picker queries against the machine the agent runs on. */
export class PickerService {
  private readonly deps: PickerServiceDeps;
  private fileCache:
    | {
        readonly cwd: string;
        readonly engine: InProcessFilePickerSuggestionEngine;
        loaded: boolean;
      }
    | undefined;
  private commandCache:
    | { readonly cwd: string; readonly items: readonly PickerItem[] }
    | undefined;

  public constructor(deps: PickerServiceDeps) {
    this.deps = deps;
  }

  public async files(
    query: string,
    limit = DEFAULT_LIMIT
  ): Promise<readonly PickerItem[]> {
    const cache = this.fileEngine();
    if (!cache.loaded) {
      await cache.engine.refreshRelative();
      cache.loaded = true;
    }
    return (await cache.engine.rank(query, { limit })) ?? [];
  }

  public commands(query: string, limit = DEFAULT_LIMIT): readonly PickerItem[] {
    return rankCommands(query, this.commandItems(), { limit });
  }

  public invalidate(): void {
    this.fileCache = undefined;
    this.commandCache = undefined;
  }

  private fileEngine(): NonNullable<PickerService["fileCache"]> {
    const cwd = this.deps.cwd();
    if (this.fileCache?.cwd !== cwd) {
      this.fileCache = {
        cwd,
        engine: new InProcessFilePickerSuggestionEngine({
          loadRelativeCatalog: () => loadRelative({ root: cwd }),
        }),
        loaded: false,
      };
    }
    return this.fileCache;
  }

  private commandItems(): readonly PickerItem[] {
    const cwd = this.deps.cwd();
    if (this.commandCache?.cwd !== cwd) {
      this.commandCache = { cwd, items: this.loadSkillItems(cwd) };
    }
    return [...this.commandCache.items, ...this.extensionItems()];
  }

  private loadSkillItems(cwd: string): readonly PickerItem[] {
    try {
      const { skills } = loadSkills({
        cwd,
        agentDir: this.deps.agentDir,
        skillPaths: [],
        includeDefaults: true,
      });
      return skills.map((skill) => ({
        value: `/skill:${skill.name}`,
        label: `/skill:${skill.name}`,
        description: skill.description,
      }));
    } catch {
      return [];
    }
  }

  private extensionItems(): readonly PickerItem[] {
    const agent = this.deps.agent?.();
    if (!agent) {
      return [];
    }
    return agent.extensionRunner.getRegisteredCommands().map((command) => ({
      value: `/${command.invocationName}`,
      label: `/${command.invocationName}`,
      ...(command.description === undefined
        ? {}
        : { description: command.description }),
    }));
  }
}
