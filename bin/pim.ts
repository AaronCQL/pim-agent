#!/usr/bin/env bun
import { Readable } from "node:stream";

import { main } from "@earendil-works/pi-coding-agent";

import {
  CoreExtensions,
  type PimInlineExtension,
} from "#core/extensions/CoreExtensions";
import { ExtensionToggles } from "#core/shared/ExtensionToggles";
import init from "#tui/extensions/_init/index";
import commandPicker from "#tui/extensions/command-picker/index";
import filePicker from "#tui/extensions/file-picker/index";
import footer from "#tui/extensions/footer/index";
import pim from "#tui/extensions/pim/index";
import tps from "#tui/extensions/tps/index";
import workingIndicator from "#tui/extensions/working-indicator/index";
import { themeCliArgs } from "#tui/themes/themeCliArgs";

// `_init` first for the runtime guard; the shared core roster carries the
// tools, and the rest is TUI chrome only this entry point wants.
const extensionFactories: readonly PimInlineExtension[] = [
  { name: "_init", factory: init },
  ...CoreExtensions.list,
  { name: "command-picker", factory: commandPicker },
  { name: "file-picker", factory: filePicker },
  { name: "footer", factory: footer },
  { name: "pim", factory: pim },
  { name: "tps", factory: tps },
  { name: "working-indicator", factory: workingIndicator },
];

async function readVersion(url: URL): Promise<string> {
  try {
    const pkg = (await Bun.file(url).json()) as { readonly version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "?";
  } catch {
    return "?";
  }
}

const cliArgs = process.argv.slice(2);

// Pi's argparse rejects prompts beginning with `-` and doesn't honour `--`
// itself; split here and hand the prompt over as piped stdin instead, which is
// the one place pi will read a prompt that argv cannot carry.
const dashDashIdx = cliArgs.indexOf("--");
let promptViaStdin: string | undefined;
if (dashDashIdx >= 0) {
  promptViaStdin = cliArgs.slice(dashDashIdx + 1).join(" ");
  cliArgs.length = dashDashIdx;
}

// Pi's `--version` would print only pi's version, which makes the distribution
// that wraps it invisible. Name both, like a distro naming its kernel.
if (cliArgs.includes("--version") || cliArgs.includes("-v")) {
  console.log(
    `pim ${await readVersion(new URL("../package.json", import.meta.url))} ` +
      `(pi ${await readVersion(new URL(import.meta.resolve("@earendil-works/pi-coding-agent/package.json")))})`
  );
  process.exit(0);
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
    const { Supervisor } = await import("#telegram/Supervisor");
    await Supervisor.install();
    process.exit(0);
  }
  if (cliArgs.includes("--uninstall")) {
    const { Supervisor } = await import("#telegram/Supervisor");
    await Supervisor.uninstall();
    process.exit(0);
  }
  const { start } = await import("#telegram/index");
  await start(cliArgs);
  process.exit(0);
}
if (mode === "serve") {
  const { start } = await import("#server/serve");
  await start(cliArgs);
  process.exit(0);
}

if (promptViaStdin !== undefined) {
  // `readPipedStdin()` only checks `isTTY` and drains the stream, so an
  // in-memory Readable is indistinguishable from a real pipe. Swapped only on
  // the `--` path so ordinary piping is untouched.
  Object.defineProperty(process, "stdin", {
    value: Readable.from([promptViaStdin]),
    configurable: true,
  });
}

// Pi's own `cli.js` preamble, minus `configureHttpDispatcher()`, which `main`
// calls itself.
process.title = "pi";
process.env["PI_CODING_AGENT"] = "true";
process.env["AI_AGENT"] = "pi";
process.emitWarning = () => {};

// No signal handlers here: the bash extension owns the sweep-then-re-raise
// sequence and now receives signals directly.

// Pi's own `enabled` filter never sees inline factories (resource-loader.js:406
// filters disk paths, then appends inline entries unconditionally), so pim's
// toggle lives in the factory itself: a disabled extension is still handed to
// pi, it just registers nothing. Pi re-invokes these on `/pim`'s reload, so a
// toggle lands in the running session.
await main([...themeCliArgs(), ...cliArgs], {
  extensionFactories: extensionFactories.map(({ name, factory }) => ({
    name,
    factory: ExtensionToggles.gate(name, factory),
  })),
});
