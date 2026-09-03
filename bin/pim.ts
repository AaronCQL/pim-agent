#!/usr/bin/env bun
import { dirname, join } from "node:path";

import { PiPackageRegistry } from "../packages/core/src/shared/PiPackageRegistry";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const PIM_PACKAGE = "@aaroncql/pim-agent";

/**
 * Resolve the pi we depend on, not whichever pi happens to be on PATH: our
 * extensions import pi's runtime values (`createAgentSession`, `SessionManager`,
 * `parseSessionEntries`), so the spawned CLI and those imports must be the same
 * copy or they become two module instances of one package.
 */
function findPiCli(): string {
  const override = process.env["PIM_PI_CLI"]?.trim();
  if (override) {
    return override;
  }

  const pkgUrl = import.meta.resolve(`${PI_PACKAGE}/package.json`);
  return join(dirname(Bun.fileURLToPath(pkgUrl)), "dist/cli.js");
}

const cliArgs = process.argv.slice(2);

// Pi's argparse rejects prompts beginning with `-` and doesn't honour `--`
// itself; do the split here and forward the prompt via pi's stdin instead.
const dashDashIdx = cliArgs.indexOf("--");
let promptViaStdin: string | undefined;
if (dashDashIdx >= 0) {
  promptViaStdin = cliArgs.slice(dashDashIdx + 1).join(" ");
  cliArgs.length = dashDashIdx;
}

const modeIdx = cliArgs.findIndex(
  (a) => a === "--mode" || a.startsWith("--mode=")
);
const mode =
  modeIdx >= 0
    ? cliArgs[modeIdx]!.includes("=")
      ? cliArgs[modeIdx]!.split("=")[1]
      : cliArgs[modeIdx + 1]
    : undefined;
if (mode === "telegram") {
  if (cliArgs.includes("--install")) {
    const { Supervisor } =
      await import("../packages/telegram/src/Supervisor.ts");
    await Supervisor.install();
    process.exit(0);
  }
  if (cliArgs.includes("--uninstall")) {
    const { Supervisor } =
      await import("../packages/telegram/src/Supervisor.ts");
    await Supervisor.uninstall();
    process.exit(0);
  }
  const { start } = await import("../packages/telegram/src/index.ts");
  await start(cliArgs);
  process.exit(0);
}

const piCli = findPiCli();

const agentDir = PiPackageRegistry.resolveAgentDir(process.env);
await PiPackageRegistry.ensureSelfRegistered({
  settingsPath: join(agentDir, "settings.json"),
  agentDir,
  packageName: PIM_PACKAGE,
  packageRoot: join(import.meta.dir, ".."),
});

const proc = Bun.spawn({
  cmd: [process.execPath, piCli, ...cliArgs],
  stdio: [
    promptViaStdin === undefined ? "inherit" : "pipe",
    "inherit",
    "inherit",
  ],
  env: process.env,
});
if (promptViaStdin !== undefined && proc.stdin) {
  proc.stdin.write(promptViaStdin);
  proc.stdin.end();
}
// Forward shutdown signals so pi's bash subtrees aren't orphaned on the host.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.once(sig, () => {
    try {
      proc.kill(sig);
    } catch {}
  });
}
const exitCode = await proc.exited;
const signalCode = proc.signalCode as NodeJS.Signals | null;
if (signalCode) {
  process.kill(process.pid, signalCode);
} else {
  process.exit(exitCode ?? 0);
}
