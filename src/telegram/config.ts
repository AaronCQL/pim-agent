import { chmod, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Paths } from "../shared/Paths.ts";

export type Cli = {
  readonly token?: string;
  readonly allow?: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly configDir?: string;
  readonly printConfig: boolean;
};

export type TelegramConfig = {
  readonly token: string;
  readonly allow: ReadonlyArray<number>;
  readonly cwd: string;
  readonly model?: string;
  readonly configDir: string;
};

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export type ThinkingLevelOpt = (typeof THINKING_LEVELS)[number];

export const LOGS_MODES = ["off", "tool", "text", "verbose"] as const;
export type LogsMode = (typeof LOGS_MODES)[number];

export type ThreadEntry = {
  readonly cwd?: string;
  readonly model?: string;
  readonly thinkingLevel?: ThinkingLevelOpt;
  readonly logsMode?: LogsMode;
  readonly sessionPath?: string;
  readonly cumulativeCost?: number;
};

export type TelegramState = {
  threads: Record<string, ThreadEntry>;
};

const DEFAULT_DIR = Paths.expandHome("~/.pim/telegram");

export function parseArgs(args: ReadonlyArray<string>): Cli {
  let token: string | undefined;
  let allow: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;
  let configDir: string | undefined;
  let printConfig = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      continue;
    }
    const eqIdx = arg.indexOf("=");
    const key = eqIdx >= 0 ? arg.slice(0, eqIdx) : arg;
    const inline = eqIdx >= 0 ? arg.slice(eqIdx + 1) : undefined;
    const take = (): string | undefined => {
      if (inline !== undefined) {
        return inline;
      }
      i += 1;
      return args[i];
    };

    switch (key) {
      case "--token":
        token = take();
        break;
      case "--allow":
        allow = take();
        break;
      case "--cwd":
        cwd = take();
        break;
      case "--model":
        model = take();
        break;
      case "--config-dir":
        configDir = take();
        break;
      case "--print-config":
        printConfig = true;
        break;
      case "--mode":
        take();
        break;
    }
  }
  return { token, allow, cwd, model, configDir, printConfig };
}

export async function loadConfig(cli: Cli): Promise<TelegramConfig> {
  const configDir =
    cli.configDir ?? process.env.PIM_TELEGRAM_DIR ?? DEFAULT_DIR;

  const filePath = join(configDir, "config.json");
  const fileConfig = await readJsonOrEmpty<Partial<TelegramConfig>>(
    filePath,
    {}
  );

  const token =
    cli.token ?? process.env.PIM_TELEGRAM_BOT_TOKEN ?? fileConfig.token;
  if (!token) {
    throw new Error(
      "Bot token required (set --token, PIM_TELEGRAM_BOT_TOKEN, or 'token' in config.json)"
    );
  }

  const allowSrc = cli.allow ?? process.env.PIM_TELEGRAM_ALLOW;
  const allow = allowSrc
    ? parseAllow(allowSrc)
    : normalizeAllow(fileConfig.allow);

  const cwd = cli.cwd ?? fileConfig.cwd ?? process.cwd();
  const model = cli.model ?? fileConfig.model;

  return { token, allow, cwd, model, configDir };
}

export async function saveConfigAtomic(config: TelegramConfig): Promise<void> {
  const filePath = join(config.configDir, "config.json");
  const data = JSON.stringify(
    {
      token: config.token,
      allow: config.allow,
      cwd: config.cwd,
      model: config.model,
    },
    null,
    2
  );
  await writeAtomic(filePath, data);
}

export async function loadState(configDir: string): Promise<TelegramState> {
  const filePath = join(configDir, "state.json");
  return readJsonOrEmpty<TelegramState>(filePath, { threads: {} });
}

export async function saveStateAtomic(
  configDir: string,
  state: TelegramState
): Promise<void> {
  const filePath = join(configDir, "state.json");
  await writeAtomic(filePath, JSON.stringify(state, null, 2));
}

function parseAllow(s: string): ReadonlyArray<number> {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
    .map((x) => {
      const n = Number(x);
      if (!Number.isFinite(n)) {
        throw new Error(`Invalid chat ID in allow list: ${x}`);
      }
      return n;
    });
}

function normalizeAllow(value: unknown): ReadonlyArray<number> {
  if (value === undefined || value === null) {
    return [];
  }
  if (typeof value === "string") {
    return parseAllow(value);
  }
  if (typeof value === "number") {
    return parseAllow(String(value));
  }
  if (Array.isArray(value)) {
    return parseAllow(value.join(","));
  }
  throw new Error(
    `Invalid 'allow' in config.json: expected number, string, or array, got ${typeof value}`
  );
}

export async function readJsonOrEmpty<T>(
  filePath: string,
  fallback: T
): Promise<T> {
  try {
    return (await Bun.file(filePath).json()) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    throw new Error(`Failed to parse ${filePath}: ${(err as Error).message}`);
  }
}

export async function writeAtomic(
  filePath: string,
  data: string
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await Bun.write(tmp, data);
  await chmod(tmp, 0o600);
  await rename(tmp, filePath);
}
