import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  AgentSession,
  ModelRegistry,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Api } from "grammy";
import { rename } from "node:fs/promises";
import { join } from "node:path";

import { Tools } from "#core/shared/Tools";
import {
  SessionHost,
  type HostSettings,
  type SessionCompactResult,
  type SetCwdResult,
  type SetModelResult,
} from "#core/session/SessionHost";
import type { LogsMode, TelegramConfig, ThinkingLevelOpt } from "./Config";
import { SendFileTool } from "./SendFileTool";
import type { TaskScheduler } from "./TaskScheduler";
import { TaskTool } from "./TaskTool";

export type { SessionCompactResult, SetCwdResult, SetModelResult };

export type SessionId = {
  readonly chatId: number;
  readonly threadId: number | undefined;
};

export type SessionSettings = HostSettings & {
  readonly logsMode?: LogsMode;
  readonly temporary?: boolean;
};

export type SessionDeps = {
  readonly id: SessionId;
  readonly settings: SessionSettings;
  readonly config: TelegramConfig;
  readonly api: Api;
  readonly agentDir: string;
  readonly modelRuntime: ModelRuntime;
  readonly modelRegistry: ModelRegistry;
  readonly scheduler: TaskScheduler;
  readonly settingsManagerFor: (cwd: string) => SettingsManager;
  readonly persistSettings: (patch: Partial<SessionSettings>) => Promise<void>;
  readonly getBotUsername: () => string | undefined;
};

const MAIN = "main";

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Telegram's adapter over the frontend-agnostic `SessionHost`: chat-scoped
 * identity, the bot's own tools and system instruction, and the two settings
 * (log verbosity, temporary mode) that only make sense in a chat.
 */
export class Session {
  public readonly id: SessionId;
  private readonly deps: SessionDeps;
  private readonly host: SessionHost;
  private chatSettings: Pick<SessionSettings, "logsMode" | "temporary">;

  public constructor(deps: SessionDeps) {
    this.deps = deps;
    this.id = deps.id;
    this.chatSettings = {
      logsMode: deps.settings.logsMode,
      temporary: deps.settings.temporary,
    };
    this.host = new SessionHost({
      label: `session ${encodeId(deps.id)}`,
      settings: deps.settings,
      defaults: { cwd: deps.config.cwd, model: deps.config.model },
      agentDir: deps.agentDir,
      modelRuntime: deps.modelRuntime,
      modelRegistry: deps.modelRegistry,
      settingsManagerFor: deps.settingsManagerFor,
      persistSettings: deps.persistSettings,
      mainSessionPath: () => this.sessionPath("sessions"),
      isolatedSessionPath: () =>
        this.sessionPath("isolated-sessions", `-${stamp()}`),
      systemInstruction: () => this.getSystemInstruction(),
      customTools: (cwd) => [
        Tools.wrap(
          SendFileTool.build({ api: deps.api, sessionId: deps.id, cwd })
        ),
        Tools.wrap(
          TaskTool.build({ scheduler: deps.scheduler, sessionId: deps.id })
        ),
      ],
      onRetire: (path) => this.archive(path),
    });
  }

  public get settings(): SessionSettings {
    return { ...this.host.settings, ...this.chatSettings };
  }

  public get lastUsed(): number {
    return this.host.lastUsed;
  }

  public set lastUsed(value: number) {
    this.host.lastUsed = value;
  }

  /** Where this session's tools resolve relative paths, session override first. */
  public get cwd(): string {
    return this.host.cwd;
  }

  public get isStreaming(): boolean {
    return this.host.isStreaming;
  }

  public get agentSession(): AgentSession | undefined {
    return this.host.agentSession;
  }

  /**
   * Pi's session UUID once an agent exists. The registry's chat-keyed map plus
   * this is the adapter-local `chatId → sessionId` mapping; pi's UUID stays the
   * only session identity anything else sees.
   */
  public get sessionId(): string | undefined {
    return this.host.sessionId;
  }

  public get currentModelId(): string | undefined {
    return this.host.currentModelId;
  }

  public get supportedThinkingLevels(): readonly ThinkingLevelOpt[] {
    return this.host.supportedThinkingLevels as readonly ThinkingLevelOpt[];
  }

  public get currentThinkingLevel(): ThinkingLevelOpt {
    return this.host.currentThinkingLevel as ThinkingLevelOpt;
  }

  public get temporary(): boolean {
    return this.chatSettings.temporary ?? false;
  }

  public run(
    work: (agent: AgentSession) => Promise<void>,
    opts?: { readonly isolated?: boolean }
  ): Promise<void> {
    return this.host.run(work, opts);
  }

  public cancel(): Promise<boolean> {
    return this.host.cancel();
  }

  public clear(): Promise<void> {
    return this.host.clear();
  }

  public setCwd(newCwd: string): Promise<SetCwdResult> {
    return this.host.setCwd(newCwd);
  }

  public setModel(pattern: string): Promise<SetModelResult> {
    return this.host.setModel(pattern);
  }

  public setThinkingLevel(level: ThinkingLevelOpt): Promise<void> {
    return this.host.setThinkingLevel(level as ThinkingLevel);
  }

  public compact(customInstructions?: string): Promise<SessionCompactResult> {
    return this.host.compact(customInstructions);
  }

  public setLogsMode(mode: LogsMode): Promise<void> {
    return this.host.serialize(async () => {
      if (this.chatSettings.logsMode === mode) {
        return;
      }
      this.chatSettings = { ...this.chatSettings, logsMode: mode };
      await this.deps.persistSettings({ logsMode: mode });
    });
  }

  public setTemporary(value: boolean): Promise<void> {
    return this.host.serialize(async () => {
      if (this.chatSettings.temporary === value) {
        return;
      }
      this.chatSettings = { ...this.chatSettings, temporary: value };
      await this.deps.persistSettings({ temporary: value });
    });
  }

  public dispose(): Promise<void> {
    return this.host.dispose();
  }

  private sessionPath(dir: string, suffix = ""): string {
    return join(
      this.deps.config.configDir,
      dir,
      `${encodeId(this.id)}${suffix}.jsonl`
    );
  }

  private async archive(path: string): Promise<void> {
    try {
      await rename(path, `${path}.archived-${stamp()}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[session ${encodeId(this.id)}] archive ${path}:`, err);
      }
    }
  }

  private async getSystemInstruction(): Promise<string | undefined> {
    const path = join(
      this.deps.config.configDir,
      "instructions",
      `${encodeId(this.id)}.md`
    );
    let userContent: string | undefined;
    try {
      userContent = (await Bun.file(path).text()).trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          `[telegram-user-instruction] failed to read ${path}:`,
          err
        );
      }
    }
    const username = this.deps.getBotUsername();
    const handle = username ? ` (@${username})` : "";
    const systemIx = `You are running as a Telegram bot${handle} powered by Pim Agent. The telegram_user_instructions below are your editable instructions - edit the file at its \`path\` attribute to update your instructions. Wrap LaTeX math in a \`\`\`math fenced block without the $$ delimitters; inline math is not supported.`;
    const userIx = `<telegram_user_instructions path="${path}">${userContent ? `\n${userContent}\n` : ""}</telegram_user_instructions>`;
    return `<telegram_system_instructions>\n${systemIx}\n${userIx}\n</telegram_system_instructions>`;
  }
}

export function encodeId(id: SessionId): string {
  return `${id.chatId}-${id.threadId ?? MAIN}`;
}

export function decodeId(s: string): SessionId {
  const idx = s.lastIndexOf("-");
  const chatId = Number(s.slice(0, idx));
  const tail = s.slice(idx + 1);
  return {
    chatId,
    threadId: tail === MAIN ? undefined : Number(tail),
  };
}
