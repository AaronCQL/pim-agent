#!/usr/bin/env bun
import { dirname, join } from "node:path";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

function findPiCli(): string {
  const globalCli = resolveGlobalPiCli();
  if (globalCli) {
    return globalCli;
  }

  try {
    const pkgUrl = import.meta.resolve(`${PI_PACKAGE}/package.json`);
    return join(dirname(Bun.fileURLToPath(pkgUrl)), "dist/cli.js");
  } catch {
    throw new Error(
      `Pim could not locate ${PI_PACKAGE}.\n` +
        `Install it globally under Bun: bun install -g ${PI_PACKAGE}`
    );
  }
}

function resolveGlobalPiCli(): string | null {
  const result = Bun.spawnSync({ cmd: ["bun", "pm", "-g", "bin"] });
  if (result.exitCode !== 0) {
    return null;
  }
  const binDir = result.stdout.toString().trim();
  if (!binDir) {
    return null;
  }
  const cliPath = join(
    binDir,
    "..",
    "install",
    "global",
    "node_modules",
    PI_PACKAGE,
    "dist",
    "cli.js"
  );
  return Bun.file(cliPath).size > 0 ? cliPath : null;
}

const cliArgs = process.argv.slice(2);
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
  const { runDaemon } = await import("../src/telegram/daemon.ts");
  await runDaemon(cliArgs);
  process.exit(0);
}

const piCli = findPiCli();
const proc = Bun.spawn({
  cmd: [process.execPath, piCli, ...process.argv.slice(2)],
  stdio: ["inherit", "inherit", "inherit"],
  env: process.env,
});
const exitCode = await proc.exited;
const signalCode = proc.signalCode as NodeJS.Signals | null;
if (signalCode) {
  process.kill(process.pid, signalCode);
} else {
  process.exit(exitCode ?? 0);
}
