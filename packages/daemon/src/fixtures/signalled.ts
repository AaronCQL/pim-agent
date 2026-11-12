import { join } from "node:path";

import { runBashCommand } from "#core/extensions/bash/run";
import { SubagentJobs } from "#core/extensions/subagent/SubagentJobs";
import { until } from "#core/shared/fixtures/wait";
import { SpillCache } from "#core/shared/SpillCache";
import { Daemon } from "../Daemon";
import { serve } from "../index";

const [home, stop] = process.argv.slice(2) as [string, "slow" | "hang"];
process.env.PIM_HOME_DIR = home;
const pidFile = join(home, "sleep.pid");
const released = Promise.withResolvers<void>();
process.once("SIGUSR2", () => released.resolve());

const daemon = new Daemon(
  [
    {
      name: "web",
      start: async () => ({
        stop: async () => {
          console.log("surface stopping");
          await (stop === "hang" ? new Promise(() => {}) : released.promise);
          console.log("surface stopped");
        },
      }),
    },
  ],
  new SubagentJobs()
);
const served = serve(daemon);

SpillCache.installSweeper();
void runBashCommand(
  `sleep 300 & echo $! > '${pidFile}.tmp' && mv '${pidFile}.tmp' '${pidFile}'; wait`,
  600_000,
  undefined,
  process.cwd()
);
await until(() => Bun.file(pidFile).exists(), "the bash command to start");
console.log("ready");

await served;
process.exit(0);
