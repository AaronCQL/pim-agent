import { Bot } from "./Bot";
import { Config } from "./Config";

export async function start(args: ReadonlyArray<string>): Promise<void> {
  const cli = Config.parseArgs(args);
  const config = await Config.load(cli);

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

  await bot.start();
}
