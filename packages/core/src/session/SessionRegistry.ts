import {
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import type { SubagentJobs } from "../extensions/subagent/SubagentJobs";
import { Directories } from "../shared/Directories";
import { Pool } from "../shared/Pool";
import type { Surface } from "../shared/Surface";
import { AgentRuntime, type ModelChoice } from "./AgentRuntime";
import { EventLog } from "./EventLog";
import { SessionCache } from "./SessionCache";
import {
  SessionHost,
  type CustomToolContext,
  type HostSettings,
} from "./SessionHost";
import { SessionLease } from "./SessionLease";
import { SessionName } from "./SessionName";
import type { SessionUi } from "./SessionUi";

export type SessionSummary = {
  readonly sessionId: string;
  readonly cwd: string;
  readonly path: string;
  readonly createdAt: number;
  readonly modifiedAt: number;
};

export type SessionRegistryDeps = {
  readonly defaults: { readonly cwd: string; readonly model?: string };
  /** Defaults to a new runtime over `agentDir`. */
  readonly runtime?: AgentRuntime;
  /** Must match pi's `getAgentDir()`. */
  readonly agentDir?: string;
  readonly capacity?: number;
  readonly customTools?: (
    context: CustomToolContext
  ) => readonly ToolDefinition[];
  /** Appended to every session's system prompt. */
  readonly systemInstruction?: () => Promise<string | undefined>;
  readonly surface?: Surface;
  /** Background subagents for every host this registry builds. */
  readonly jobs?: SubagentJobs;
};

export type SessionCreateOptions = {
  readonly cwd?: string;
  /** Copies model, thinking level, subagent choice and (if `cwd` is unset) cwd from this host. */
  readonly like?: SessionHost;
};

/** The one frontend serving this registry's hosts. */
export type RegistryFrontend = {
  /** UI sink for hosts built after `bind`. */
  readonly ui: (host: SessionHost) => SessionUi | undefined;
  /** Sessions in use: never evicted. */
  readonly holds: (sessionId: string) => boolean;
  /** A session's host is being disposed; drop everything that reaches it. */
  readonly evicted: (sessionId: string) => void;
};

/** Concurrent header reads, to avoid running out of file descriptors. */
const HEADER_READS = 32;

/** Live sessions keyed by pi's session id, plus listing of pi's sessions directory. */
export class SessionRegistry {
  private readonly deps: SessionRegistryDeps;
  private readonly runtime: AgentRuntime;
  private readonly hosts: SessionCache<SessionHost>;
  private frontend: RegistryFrontend | undefined;

  public constructor(deps: SessionRegistryDeps) {
    this.deps = deps;
    this.runtime = deps.runtime ?? new AgentRuntime(deps.agentDir);
    this.hosts = new SessionCache(deps.capacity, {
      held: (sessionId) => this.frontend?.holds(sessionId) === true,
      evicted: (sessionId) => this.frontend?.evicted(sessionId),
    });
  }

  public bind(frontend: RegistryFrontend): void {
    this.frontend = frontend;
  }

  /** Background subagents of every host this registry builds. */
  public get jobs(): SubagentJobs | undefined {
    return this.deps.jobs;
  }

  public get sessionsRoot(): string {
    return join(this.runtime.agentDir, "sessions");
  }

  public get agentDir(): string {
    return this.runtime.agentDir;
  }

  public async init(): Promise<void> {
    await this.runtime.init();
  }

  /** Newest first; reads only each file's header. */
  public async list(cwd?: string): Promise<readonly SessionSummary[]> {
    const summaries = (
      await Pool.mapPooled(
        await this.paths("*/*.jsonl"),
        HEADER_READS,
        readSummary
      )
    ).filter(
      (summary): summary is SessionSummary =>
        summary !== undefined && (cwd === undefined || summary.cwd === cwd)
    );
    return summaries.sort((a, b) => b.modifiedAt - a.modifiedAt);
  }

  public peek(sessionId: string): SessionHost | undefined {
    return this.hosts.peek(sessionId);
  }

  /**
   * Sets pi's session name; `null` clears it. A closed session's file is
   * appended to under the turn lease. Returns the stored name.
   */
  public async setName(
    sessionId: string,
    name: string | null
  ): Promise<string | undefined> {
    const host = this.peek(sessionId);
    if (host?.agentSession) {
      return await host.setName(name);
    }
    const summary = await this.find(sessionId);
    if (summary === undefined) {
      throw new Error(`unknown session: ${sessionId}`);
    }
    const next = SessionName.normalise(name);
    // Fails fast instead of waiting out a whole turn.
    return await SessionLease.hold(
      summary.path,
      "daemon",
      async () => {
        const manager = SessionManager.open(summary.path);
        manager.appendSessionInfo(next);
        return manager.getSessionName();
      },
      { timeoutMs: 0 }
    );
  }

  public models(): readonly ModelChoice[] {
    return this.runtime.models();
  }

  public async open(sessionId: string): Promise<SessionHost> {
    const cached = this.hosts.touch(sessionId);
    if (cached) {
      return cached;
    }
    const summary = await this.find(sessionId);
    if (!summary) {
      throw new Error(`unknown session: ${sessionId}`);
    }
    return this.hosts.adopt(
      sessionId,
      this.buildHost(sessionId, {
        cwd: summary.cwd,
        sessionPath: summary.path,
      })
    );
  }

  /** Builds the agent eagerly: pi assigns the session id. */
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
    if (like !== undefined) {
      await host.setSubagentChoice(like.subagentChoice);
    }
    return this.hosts.adopt(agent.sessionId, host);
  }

  public async disposeAll(): Promise<void> {
    await this.hosts.disposeAll();
  }

  /** Tries files named for the id first, then falls back to a full listing. */
  private async find(sessionId: string): Promise<SessionSummary | undefined> {
    for (const path of await this.paths(`*/*${sessionId}.jsonl`)) {
      const summary = await readSummary(path);
      if (summary?.sessionId === sessionId) {
        return summary;
      }
    }
    return (await this.list()).find(
      (summary) => summary.sessionId === sessionId
    );
  }

  private async paths(pattern: string): Promise<readonly string[]> {
    const root = this.sessionsRoot;
    if (!(await stat(root).catch(() => undefined))?.isDirectory()) {
      return [];
    }
    const found: string[] = [];
    for await (const relative of new Bun.Glob(pattern).scan({
      cwd: root,
      onlyFiles: true,
    })) {
      found.push(join(root, relative));
    }
    return found;
  }

  private buildHost(label: string, settings: HostSettings): SessionHost {
    const ui = this.frontend?.ui;
    const host: SessionHost = new SessionHost({
      label: `session ${label}`,
      settings,
      defaults: this.deps.defaults,
      agentDir: this.runtime.agentDir,
      modelRuntime: this.runtime.modelRuntime,
      modelRegistry: this.runtime.modelRegistry,
      settingsManagerFor: (cwd) => this.runtime.settingsManagerFor(cwd),
      persistSettings: async () => {},
      lease: "daemon",
      customTools: this.deps.customTools,
      ...(this.deps.systemInstruction === undefined
        ? {}
        : { systemInstruction: this.deps.systemInstruction }),
      ...(this.deps.surface === undefined
        ? {}
        : { surface: this.deps.surface }),
      ...(ui === undefined ? {} : { ui: () => ui(host) }),
      ...(this.deps.jobs === undefined ? {} : { jobs: this.deps.jobs }),
    });
    return host;
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
