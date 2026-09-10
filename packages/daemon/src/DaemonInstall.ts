import { join } from "node:path";

import { DaemonUnit, SupersededUnits } from "#core/shared/DaemonUnit";
import { Supervisor, type Unit } from "#core/shared/Supervisor";
import { DEFAULT_CLIENT_DIR } from "#server/StaticClient";
import { WebOptions } from "#server/WebOptions";
import { Surfaces, type SurfaceName } from "./Surfaces";

type FrozenUnit = Unit & { readonly args: ReadonlyArray<string> };

/** What this machine serves today: the unit being replaced, or the ones it supersedes. */
export type Installed = {
  readonly surfaces: ReadonlyArray<SurfaceName>;
  readonly args: ReadonlyArray<string>;
};

const NOTHING: Installed = { surfaces: [], args: [] };

/**
 * A supervisor starts the daemon with no argv: every flag it needs must be
 * frozen in here. What is installed already is the base the new argv overrides
 * flag by flag, so installing one surface keeps the other one — and its
 * settings. Naming `--surfaces` outright is how a daemon is shrunk again.
 */
function unit(
  argv: ReadonlyArray<string>,
  installed: Installed = NOTHING
): FrozenUnit {
  const surfaces = Surfaces.named(argv)
    ? Surfaces.parse(argv)
    : Surfaces.union(installed.surfaces, Surfaces.parse(argv));
  const merged = [...installed.args, ...argv];
  return {
    ...DaemonUnit,
    description: `${DaemonUnit.description} (${surfaces.join(", ")})`,
    args: [
      "--surfaces",
      Surfaces.format(surfaces),
      ...(surfaces.includes("web")
        ? WebOptions.freeze(WebOptions.parse(merged))
        : []),
    ],
  };
}

/**
 * The merged unit's own argv, or — before the cutover — whatever the per-surface
 * units were installed with, so a tailnet hostname frozen months ago survives.
 */
async function installed(): Promise<Installed> {
  const current = await Supervisor.installedArgs(DaemonUnit);
  if (current.length > 0) {
    return { surfaces: Surfaces.parse(current), args: carriedOver(current) };
  }
  const superseded = (
    await Promise.all(
      SupersededUnits.map((unit) => Supervisor.installedArgs(unit))
    )
  ).filter((args) => args.length > 0);
  return {
    surfaces: Surfaces.union(...superseded.map(Surfaces.parse)),
    args: superseded.flatMap(carriedOver),
  };
}

// `--web-cwd` becomes `--cwd` on the way in, or it would outrank a new `--cwd`.
function carriedOver(args: ReadonlyArray<string>): ReadonlyArray<string> {
  return args.map((arg) => (arg === "--web-cwd" ? "--cwd" : arg));
}

async function install(argv: ReadonlyArray<string>): Promise<void> {
  const descriptor = unit(argv, await installed());
  const surfaces = Surfaces.parse(descriptor.args);
  if (surfaces.includes("web")) {
    await buildClient();
  }
  const kept = surfaces.filter((name) => !Surfaces.parse(argv).includes(name));
  if (kept.length > 0) {
    console.log(
      `[install] keeping the ${kept.join(", ")} surface this machine already serves; pass --surfaces to change that`
    );
  }
  console.log(
    `[install] unit starts: pim --mode ${descriptor.mode} ${descriptor.args.join(" ")}`
  );
  await Supervisor.install(descriptor, { replaces: SupersededUnits });
}

async function uninstall(): Promise<void> {
  await Supervisor.uninstall(DaemonUnit);
  await Supervisor.supersede(SupersededUnits);
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

export const DaemonInstall = { unit, installed, install, uninstall };
