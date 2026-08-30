import { relative } from "node:path";
import { Paths } from "./Paths";

export class GlobExclusions {
  public static compile(
    exclude: readonly string[] | undefined
  ): readonly Bun.Glob[] {
    return (exclude ?? []).map((pattern) => new Bun.Glob(pattern));
  }

  public static ignores(
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
}
