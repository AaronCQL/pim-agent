#!/usr/bin/env bun
import { Readable } from "node:stream";

import { main } from "@earendil-works/pi-coding-agent";

import {
  CoreExtensions,
  type PimInlineExtension,
} from "#core/extensions/CoreExtensions";
import { ExtensionToggles } from "#core/shared/ExtensionToggles";
import { PimVersion } from "#core/shared/PimVersion";
import { Supervisor } from "#core/shared/Supervisor";
import { Updater } from "#core/shared/Updater";
import init from "#tui/extensions/_init/index";
import commandPicker from "#tui/extensions/command-picker/index";
import filePicker from "#tui/extensions/file-picker/index";
import footer from "#tui/extensions/footer/index";
import pim from "#tui/extensions/pim/index";
import sessionLease from "#tui/extensions/session-lease/index";
import tps from "#tui/extensions/tps/index";
import workingIndicator from "#tui/extensions/working-indicator/index";
import { themeCliArgs } from "#tui/themes/themeCliArgs";

// `_init` must stay first: it installs the runtime guard.
const extensionFactories: readonly PimInlineExtension[] = [
  { name: "_init", factory: init },
  ...CoreExtensions.list,
  { name: "command-picker", factory: commandPicker },
  { name: "file-picker", factory: filePicker },
  { name: "footer", factory: footer },
  { name: "pim", factory: pim },
  { name: "session-lease", factory: sessionLease },
  { name: "tps", factory: tps },
  { name: "working-indicator", factory: workingIndicator },
];

async function runUpdate(force: boolean): Promise<number> {
  const at = await Supervisor.detectInstall();
  if (!force && at.kind === "prod") {
    const [installed, available] = await Promise.all([
      PimVersion.current(),
      PimVersion.latest({ timeoutMs: 10_000 }),
    ]);
    if (available === undefined) {
      console.error("Could not determine the latest pim version.");
      return 1;
    }
    if (!PimVersion.isNewer(available, installed)) {
      console.log(`pim is already up to date (v${installed})`);
      return 0;
    }
  }
  const outcome = await Updater.run({
    onStep: (label) => console.log(`[update] ${label}`),
  });
  for (const skip of outcome.skipped) {
    console.log(`[update] skipped ${skip.label}: ${skip.reason}`);
  }
  if (!outcome.ok) {
    console.error(outcome.error);
    return 1;
  }
  console.log(
    outcome.to === outcome.from
      ? `pim is on v${outcome.to}`
      : `Updated pim from v${outcome.from} to v${outcome.to}`
  );
  return 0;
}

const cliArgs = process.argv.slice(2);

// Pi's argparse rejects prompts starting with `-` and ignores `--`; route them through stdin.
const dashDashIdx = cliArgs.indexOf("--");
let promptViaStdin: string | undefined;
if (dashDashIdx >= 0) {
  promptViaStdin = cliArgs.slice(dashDashIdx + 1).join(" ");
  cliArgs.length = dashDashIdx;
}

if (cliArgs.includes("--version") || cliArgs.includes("-v")) {
  console.log(
    `pim ${await PimVersion.current()} (pi ${await PimVersion.pi()})`
  );
  process.exit(0);
}

// Pi's `update` cannot move the pi inside pim's install tree; only reinstalling pim can.
if (cliArgs[0] === "update") {
  const rest = cliArgs.slice(1);
  const isSelf = rest.every(
    (arg) => arg === "self" || arg === "pim" || arg === "--force"
  );
  if (isSelf) {
    process.exit(await runUpdate(rest.includes("--force")));
  }
}

// Pi's banner points at `pi update`, which cannot reach the bundled copy.
process.env["PI_SKIP_VERSION_CHECK"] = "1";

const modeIdx = cliArgs.findIndex(
  (a) => a === "--mode" || a.startsWith("--mode=")
);
const mode =
  modeIdx >= 0
    ? cliArgs[modeIdx]!.includes("=")
      ? cliArgs[modeIdx]!.split("=")[1]
      : cliArgs[modeIdx + 1]
    : undefined;
// Writing a unit file must not load the frontend it describes; keep these imports lazy.
const daemonAction = cliArgs.includes("--install")
  ? "install"
  : cliArgs.includes("--uninstall")
    ? "uninstall"
    : undefined;
// `--mode web` and `--mode telegram` are the single-surface spellings of the daemon.
if (mode === "daemon" || mode === "web" || mode === "telegram") {
  if (daemonAction !== undefined) {
    const { DaemonInstall } = await import("#daemon/DaemonInstall");
    await (daemonAction === "install"
      ? DaemonInstall.install(cliArgs)
      : DaemonInstall.uninstall());
    process.exit(0);
  }
  const { start } = await import("#daemon/index");
  await start(cliArgs);
  process.exit(0);
}

if (promptViaStdin !== undefined) {
  // Pi's `readPipedStdin()` only checks `isTTY` and drains, so an in-memory Readable passes as a pipe.
  Object.defineProperty(process, "stdin", {
    value: Readable.from([promptViaStdin]),
    configurable: true,
  });
}

// Pi's `cli.js` preamble, minus `configureHttpDispatcher()`, which `main` calls itself.
process.title = "pi";
process.env["PI_CODING_AGENT"] = "true";
process.env["AI_AGENT"] = "pi";
process.emitWarning = () => {};

// Pi never applies its `enabled` filter to inline factories, so the toggle must gate inside the factory.
await main([...themeCliArgs(cliArgs), ...cliArgs], {
  extensionFactories: extensionFactories.map(({ name, factory }) => ({
    name,
    factory: ExtensionToggles.gate(name, factory),
  })),
});
