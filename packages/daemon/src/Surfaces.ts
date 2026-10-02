import { Cli as Argv } from "#core/shared/Cli";

const SURFACE_NAMES = ["web", "telegram"] as const;

export type SurfaceName = (typeof SURFACE_NAMES)[number];

function isSurfaceName(value: string | undefined): value is SurfaceName {
  return SURFACE_NAMES.includes(value as SurfaceName);
}

/** `--mode web` and `--mode telegram` are the single-surface spellings of `--surfaces`. */
function parse(args: ReadonlyArray<string>): ReadonlyArray<SurfaceName> {
  let requested: string | undefined;
  let mode: string | undefined;
  Argv.scan(args, (key, take) => {
    switch (key) {
      case "--surfaces":
        requested = take() ?? requested;
        break;
      case "--mode":
        mode = take() ?? mode;
        break;
      default:
        break;
    }
  });
  if (requested === undefined) {
    return isSurfaceName(mode) ? [mode] : SURFACE_NAMES;
  }
  const names = requested
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const unknown = names.filter((name) => !isSurfaceName(name));
  if (names.length === 0 || unknown.length > 0) {
    throw new Error(
      `--surfaces takes a comma-separated list of ${SURFACE_NAMES.join(", ")}, got "${requested}"`
    );
  }
  return SURFACE_NAMES.filter((name) => names.includes(name));
}

function named(args: ReadonlyArray<string>): boolean {
  return args.some(
    (arg) => arg === "--surfaces" || arg.startsWith("--surfaces=")
  );
}

function union(
  ...groups: ReadonlyArray<ReadonlyArray<SurfaceName>>
): ReadonlyArray<SurfaceName> {
  return SURFACE_NAMES.filter((name) =>
    groups.some((group) => group.includes(name))
  );
}

export const Surfaces = { parse, named, union };
