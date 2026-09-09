import { join, resolve } from "node:path";

import { Supervisor, type Unit } from "#core/shared/Supervisor";
import { parseArgs } from "./serve";
import { DEFAULT_CLIENT_DIR } from "./StaticClient";

const UNIT = {
  mode: "web",
  description: "Pim web daemon",
} satisfies Unit;

type FrozenUnit = Unit & { readonly args: ReadonlyArray<string> };

// A supervisor starts the daemon with no argv: every flag it needs must be frozen in here, cwd included.
function unit(argv: ReadonlyArray<string>): FrozenUnit {
  const cli = parseArgs(argv);
  return {
    ...UNIT,
    args: [
      "--port",
      cli.port,
      "--hostname",
      cli.hostname,
      "--cwd",
      resolve(cli.cwd),
      ...(cli.clientDir === undefined
        ? []
        : ["--client-dir", resolve(cli.clientDir)]),
    ],
  };
}

async function install(argv: ReadonlyArray<string>): Promise<void> {
  const descriptor = unit(argv);
  await buildClient();
  console.log(
    `[install] unit starts: pim --mode ${descriptor.mode} ${descriptor.args.join(" ")}`
  );
  await Supervisor.install(descriptor);
}

async function uninstall(): Promise<void> {
  await Supervisor.uninstall(UNIT);
}

async function buildClient(): Promise<void> {
  const at = await Supervisor.detectInstall();
  // Probe `index.html`, not the directory: a half-emptied `dist/client` is still a broken bundle.
  const bundled = await Bun.file(
    join(DEFAULT_CLIENT_DIR, "index.html")
  ).exists();
  if (at.kind !== "dev" || bundled) {
    return;
  }
  console.log("[install] building the web client");
  const proc = Bun.spawn(["bun", "run", "web:build"], {
    cwd: at.packageRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`bun run web:build exited ${code}`);
  }
}

export const WebUnit = { descriptor: UNIT, unit, install, uninstall };
