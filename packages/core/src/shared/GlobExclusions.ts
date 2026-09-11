import { relative } from "node:path";
import { Paths } from "./Paths";

function compile(exclude: readonly string[] | undefined): readonly Bun.Glob[] {
  return (exclude ?? []).map((pattern) => new Bun.Glob(pattern));
}

function ignores(
  globs: readonly Bun.Glob[],
  root: string,
  path: string
): boolean {
  if (globs.length === 0) {
    return false;
  }

  const candidate = Paths.toForwardSlashes(relative(root, path));
  return globs.some((glob) => glob.match(candidate));
}

export const GlobExclusions = { compile, ignores };
