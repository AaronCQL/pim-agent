import { Bot } from "#telegram/Bot";
import { Config } from "#telegram/Config";
import type { Surface, SurfaceDeps } from "./Daemon";

function create(args: ReadonlyArray<string>, deps: SurfaceDeps): Surface {
  return {
    name: "telegram",
    start: async () => {
      const config = await Config.load(Config.parseArgs(args));
      const bot = new Bot(config, deps.runtime, { jobs: deps.jobs });
      await bot.start();
      return { stop: () => bot.stop() };
    },
  };
}

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
