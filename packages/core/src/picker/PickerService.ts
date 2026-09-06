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

/**
 * Answers one session's picker queries against the machine the agent runs on.
 *
 * Both halves are deliberately server-side. `@` names a file the *agent* must
 * open, and a skill is a capability loaded from the agent's disk — neither
 * means anything on a client, so neither is ever shipped there. What crosses
 * the wire is one query and at most `limit` ranked rows.
 */
export class PickerService {
  private readonly deps: PickerServiceDeps;
  private engine: InProcessFilePickerSuggestionEngine | undefined;
  private engineCwd: string | undefined;
  private catalogLoaded = false;
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
    const engine = this.fileEngine();
    if (!this.catalogLoaded) {
      await engine.refreshRelative();
      this.catalogLoaded = true;
    }
    return (await engine.rank(query, { limit })) ?? [];
  }

  public commands(query: string, limit = DEFAULT_LIMIT): readonly PickerItem[] {
    return rankCommands(query, this.commandItems(), { limit });
  }

  /**
   * Drop everything derived from the filesystem. The cwd moved, or something
   * wrote to it — either way the catalog and the skill list are now stale.
   */
  public invalidate(): void {
    this.engine = undefined;
    this.engineCwd = undefined;
    this.catalogLoaded = false;
    this.commandCache = undefined;
  }

  private fileEngine(): InProcessFilePickerSuggestionEngine {
    const cwd = this.deps.cwd();
    if (this.engine === undefined || this.engineCwd !== cwd) {
      this.engine = new InProcessFilePickerSuggestionEngine({
        loadRelativeCatalog: () => loadRelative({ root: cwd }),
      });
      this.engineCwd = cwd;
      this.catalogLoaded = false;
    }
    return this.engine;
  }

  private commandItems(): readonly PickerItem[] {
    const cwd = this.deps.cwd();
    if (this.commandCache?.cwd !== cwd) {
      this.commandCache = { cwd, items: this.loadSkillItems(cwd) };
    }
    return [...this.commandCache.items, ...this.extensionItems()];
  }

  /**
   * Project-local `.agents/skills` hangs off the session cwd, so the skill
   * list is a function of cwd and nothing else — which is why it is cached
   * beside it rather than read from a live agent.
   */
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
