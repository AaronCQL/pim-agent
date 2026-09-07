import { join, resolve } from "node:path";

import { Supervisor, type Unit } from "#core/shared/Supervisor";
import { parseArgs } from "./serve";
import { DEFAULT_CLIENT_DIR } from "./StaticClient";

const UNIT = {
  mode: "web",
  description: "Pim web daemon",
} satisfies Unit;

/** A unit that carries the flags the daemon cannot recover for itself. */
type FrozenUnit = Unit & { readonly args: ReadonlyArray<string> };

/**
 * Freezes the flags this install was given into the unit. A supervisor starts
 * the daemon with no argv, so a flag left off here is gone for good; the cwd
 * is spelled out even when it was never passed, because sessions default to
 * it and inheriting the supervisor's would point them somewhere meaningless.
 */
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

/**
 * A checkout has no bundle until someone builds one, and a daemon whose first
 * page is the build hint reads as broken. Installed copies ship it prebuilt.
 */
async function buildClient(): Promise<void> {
  const at = await Supervisor.detectInstall();
  // `index.html` and not the directory: its absence is what the server answers
  // with the hint, and a half-emptied `dist/client` is still a broken bundle.
  const bundled = await Bun.file(
    join(DEFAULT_CLIENT_DIR, "index.html")
  ).exists();
  if (at.kind !== "dev" || bundled) {
    return;
  }
  console.log("[install] building the web client");
  const proc = Bun.spawn(["bun", "run", "build:web"], {
    cwd: at.packageRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`bun run build:web exited ${code}`);
  }
}

export const WebUnit = { descriptor: UNIT, unit, install, uninstall };
