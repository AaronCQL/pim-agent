import { Bot } from "./Bot.ts";
import { loadConfig, parseArgs } from "./config.ts";

export async function runDaemon(args: ReadonlyArray<string>): Promise<void> {
  const cli = parseArgs(args);
  const config = await loadConfig(cli);

  if (cli.printConfig) {
    console.log(
      JSON.stringify(
        { ...config, token: config.token ? "***" : undefined },
        null,
        2
      )
    );
    return;
  }

  const bot = new Bot(config);
  let stopped = false;
  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    void bot.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await bot.run();
}
