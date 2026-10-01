import { join } from "node:path";

import { DaemonUnit, SupersededUnits } from "#core/shared/DaemonUnit";
import { Supervisor, type Unit } from "#core/shared/Supervisor";
import { DEFAULT_CLIENT_DIR } from "#server/StaticClient";
import { WebOptions } from "#server/WebOptions";
import { Surfaces, type SurfaceName } from "./Surfaces";

type FrozenUnit = Unit & { readonly args: ReadonlyArray<string> };

export type Installed = {
  readonly surfaces: ReadonlyArray<SurfaceName>;
  readonly args: ReadonlyArray<string>;
};

const NOTHING: Installed = { surfaces: [], args: [] };

/**
 * The supervisor starts the daemon with no argv, so every flag is frozen here.
 * `argv` overrides `installed` flag by flag; an explicit `--surfaces` replaces the surface list.
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
      surfaces.join(","),
      ...(surfaces.includes("web")
        ? WebOptions.freeze(WebOptions.parse(merged))
        : []),
    ],
  };
}

/** The daemon unit's argv, falling back to the superseded per-surface units'. */
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

// Map `--web-cwd` back to `--cwd` so a new `--cwd` can override it.
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
