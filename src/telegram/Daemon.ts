import { Bot } from "./Bot.ts";
import { Config } from "./Config.ts";

export class Daemon {
  public static async main(args: ReadonlyArray<string>): Promise<void> {
    const cli = Config.parseArgs(args);
    const config = await Config.loadConfig(cli);

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
}
