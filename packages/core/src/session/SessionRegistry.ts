import {
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { stat } from "node:fs/promises";
import { join } from "node:path";

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
  /** Where this frontend's human is reading. */
  readonly surface?: Surface;
};

export type SessionCreateOptions = {
  readonly cwd?: string;
  /** Open the new session like this one: model, chosen thinking level, and cwd when none is given. */
  readonly like?: SessionHost;
};

/** A session tree is thousands of files and each header is one open; fanning out over all of them at once is how a listing runs the process out of descriptors. */
const HEADER_READS = 32;

/** Live sessions keyed on pi's session UUID; the catalogue is pi's sessions directory, read on demand. */
export class SessionRegistry {
  private readonly deps: SessionRegistryDeps;
  private readonly runtime: AgentRuntime;
  private readonly hosts: SessionCache<SessionHost>;
  private ui: ((host: SessionHost) => SessionUi | undefined) | undefined;

  public constructor(deps: SessionRegistryDeps) {
    this.deps = deps;
    this.runtime = deps.runtime ?? new AgentRuntime(deps.agentDir);
    this.hosts = new SessionCache(deps.capacity);
  }

  /**
   * Where the extensions of every host built from here speak. It belongs to the
   * registry rather than each caller because `create` binds an agent eagerly,
   * and pi freezes a session's UI mode at that bind. Resolved per call: a
   * host outlives the stream that speaks for it.
   */
  public setUi(ui: (host: SessionHost) => SessionUi | undefined): void {
    this.ui = ui;
  }

  public get sessionsRoot(): string {
    return join(this.runtime.agentDir, "sessions");
  }

  public async init(): Promise<void> {
    await this.runtime.init();
  }

  /** Sessions on disk, newest first; reads only each file's header line. */
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

  /** The live host for `sessionId`, if one is currently loaded. */
  public peek(sessionId: string): SessionHost | undefined {
    return this.hosts.peek(sessionId);
  }

  /**
   * Rename a session through pi's own session name, so its `/resume` picker shows
   * it too; `null` clears it. A live session is renamed by its agent, a closed one
   * by appending to its file under the turn lease. Answers with the name pi kept.
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
    // Reopening is a plain read today, but a pi that migrates the file rewrites it.
    // The lease is only ever held for a whole turn, so a rename refuses rather than queues.
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

  /** Every model this machine has credentials for, qualified as `SessionHost.setModel` takes them. */
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

  /**
   * One session by id. Pi names a file for the id it carries, so the usual
   * answer is one glob and one header; resolving it by listing would read the
   * header of every session on disk to throw all but one away.
   */
  private async find(sessionId: string): Promise<SessionSummary | undefined> {
    for (const path of await this.paths(`*/*${sessionId}.jsonl`)) {
      const summary = await readSummary(path);
      if (summary?.sessionId === sessionId) {
        return summary;
      }
    }
    // A file named something else entirely: the id is the header's, not the name's.
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
    const ui = this.ui;
    // Named so the sink can reach back for the host it belongs to; the closure
    // only ever runs once construction has returned.
    const host: SessionHost = new SessionHost({
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
      ...(this.deps.surface === undefined
        ? {}
        : { surface: this.deps.surface }),
      ...(ui === undefined ? {} : { ui: () => ui(host) }),
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
