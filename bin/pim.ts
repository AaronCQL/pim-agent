#!/usr/bin/env bun
import { Readable } from "node:stream";

import { main } from "@earendil-works/pi-coding-agent";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

import applyPatch from "../packages/core/src/extensions/apply-patch/index.ts";
import bash from "../packages/core/src/extensions/bash/index.ts";
import edit from "../packages/core/src/extensions/edit/index.ts";
import glob from "../packages/core/src/extensions/glob/index.ts";
import grep from "../packages/core/src/extensions/grep/index.ts";
import read from "../packages/core/src/extensions/read/index.ts";
import subagent from "../packages/core/src/extensions/subagent/index.ts";
import systemPrompt from "../packages/core/src/extensions/system-prompt/index.ts";
import todo from "../packages/core/src/extensions/todo/index.ts";
import webFetch from "../packages/core/src/extensions/web-fetch/index.ts";
import webSearch from "../packages/core/src/extensions/web-search/index.ts";
import write from "../packages/core/src/extensions/write/index.ts";
import {
  ExtensionToggles,
  type PimExtensionName,
} from "../packages/core/src/shared/ExtensionToggles.ts";
import init from "../packages/tui/src/extensions/_init/index.ts";
import commandPicker from "../packages/tui/src/extensions/command-picker/index.ts";
import extensionToggle from "../packages/tui/src/extensions/extension-toggle/index.ts";
import filePicker from "../packages/tui/src/extensions/file-picker/index.ts";
import footer from "../packages/tui/src/extensions/footer/index.ts";
import tps from "../packages/tui/src/extensions/tps/index.ts";
import workingIndicator from "../packages/tui/src/extensions/working-indicator/index.ts";
import { themeCliArgs } from "../packages/tui/src/themes/themeCliArgs.ts";

type PimInlineExtension = InlineExtension & { readonly name: PimExtensionName };

// Enumerated rather than globbed: the published tarball must not depend on a
// directory scan, and pi never sees these as files on disk.
const extensionFactories: readonly PimInlineExtension[] = [
  { name: "_init", factory: init },
  { name: "apply-patch", factory: applyPatch },
  { name: "bash", factory: bash },
  { name: "command-picker", factory: commandPicker },
  { name: "edit", factory: edit },
  { name: "extension-toggle", factory: extensionToggle },
  { name: "file-picker", factory: filePicker },
  { name: "footer", factory: footer },
  { name: "glob", factory: glob },
  { name: "grep", factory: grep },
  { name: "read", factory: read },
  { name: "subagent", factory: subagent },
  { name: "system-prompt", factory: systemPrompt },
  { name: "todo", factory: todo },
  { name: "tps", factory: tps },
  { name: "web-fetch", factory: webFetch },
  { name: "web-search", factory: webSearch },
  { name: "working-indicator", factory: workingIndicator },
  { name: "write", factory: write },
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
if (mode === "serve") {
  const { start } = await import("../packages/server/src/serve.ts");
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
// toggle has to happen here, before `main` ever sees the list.
const enabledFactories = ExtensionToggles.filter(
  extensionFactories,
  await ExtensionToggles.disabled()
);

await main([...themeCliArgs(), ...cliArgs], {
  extensionFactories: [...enabledFactories],
});
