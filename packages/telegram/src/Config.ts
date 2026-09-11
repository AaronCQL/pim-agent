import { join } from "node:path";

import { Cli as Argv } from "#core/shared/Cli";
import { Fs } from "#core/shared/Fs";
import { Paths } from "#core/shared/Paths";

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

function parseArgs(args: ReadonlyArray<string>): Cli {
  let token: string | undefined;
  let allow: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;
  let configDir: string | undefined;
  let printConfig = false;

  Argv.scan(args, (key, take) => {
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
  });
  return { token, allow, cwd, model, configDir, printConfig };
}

async function load(cli: Cli): Promise<TelegramConfig> {
  const configDir = cli.configDir ?? join(Paths.pimHomeDir(), "telegram");

  const filePath = join(configDir, "config.json");
  const fileConfig = await Fs.readJsonOrEmpty<Partial<TelegramConfig>>(
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

async function save(config: TelegramConfig): Promise<void> {
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
  await Fs.writeAtomic(filePath, data, 0o600);
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

export const Config = { parseArgs, load, save };
