import type { AgentRuntime } from "#core/session/AgentRuntime";
import { Bot } from "#telegram/Bot";
import { Config } from "#telegram/Config";
import type { Surface } from "./Daemon";

function create(args: ReadonlyArray<string>, runtime: AgentRuntime): Surface {
  return {
    name: "telegram",
    start: async () => {
      const config = await Config.load(Config.parseArgs(args));
      const bot = new Bot(config, runtime);
      await bot.start();
      return { stop: () => bot.stop() };
    },
  };
}

/** `--print-config`, which resolves the bot's config the way a run would and stops there. */
async function printConfig(args: ReadonlyArray<string>): Promise<void> {
  const config = await Config.load(Config.parseArgs(args));
  console.log(
    JSON.stringify(
      { ...config, token: config.token ? "***" : undefined },
      null,
      2
    )
  );
}

export const TelegramSurface = { create, printConfig };
