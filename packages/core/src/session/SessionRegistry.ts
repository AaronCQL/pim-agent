import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { Directories } from "../shared/Directories";
import { AgentRuntime, type ModelChoice } from "./AgentRuntime";
import { EventLog } from "./EventLog";
import { SessionCache } from "./SessionCache";
import {
  SessionHost,
  type CustomToolContext,
  type HostSettings,
} from "./SessionHost";

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
  /** The process-wide pi installation; one is built here when a caller has none to share. */
  readonly runtime?: AgentRuntime;
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
  private readonly runtime: AgentRuntime;
  private readonly hosts: SessionCache<SessionHost>;

  public constructor(deps: SessionRegistryDeps) {
    this.deps = deps;
    this.runtime = deps.runtime ?? new AgentRuntime(deps.agentDir);
    this.hosts = new SessionCache(deps.capacity);
  }

  public get sessionsRoot(): string {
    return join(this.runtime.agentDir, "sessions");
  }

  public async init(): Promise<void> {
    await this.runtime.init();
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
    return this.hosts.peek(sessionId);
  }

  /** Every model this machine has credentials for, qualified as `SessionHost.setModel` takes them. */
  public models(): readonly ModelChoice[] {
    return this.runtime.models();
  }

  public async open(sessionId: string): Promise<SessionHost> {
    const cached = this.hosts.touch(sessionId);
    if (cached) {
      return cached;
    }
    const summary = (await this.list()).find((s) => s.sessionId === sessionId);
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
    return this.hosts.adopt(agent.sessionId, host);
  }

  public async disposeAll(): Promise<void> {
    await this.hosts.disposeAll();
  }

  private buildHost(label: string, settings: HostSettings): SessionHost {
    return new SessionHost({
      label: `session ${label}`,
      settings,
      defaults: this.deps.defaults,
      agentDir: this.runtime.agentDir,
      modelRuntime: this.runtime.modelRuntime,
      modelRegistry: this.runtime.modelRegistry,
      settingsManagerFor: (cwd) => this.runtime.settingsManagerFor(cwd),
      persistSettings: async () => {},
      // The terminal can hold the same file open, so every mutation goes through the turn lease.
      lease: "daemon",
      customTools: this.deps.customTools,
      ...(this.deps.systemInstruction === undefined
        ? {}
        : { systemInstruction: this.deps.systemInstruction }),
    });
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
