function compile(exclude: readonly string[] | undefined): readonly Bun.Glob[] {
  return (exclude ?? []).map((pattern) => new Bun.Glob(pattern));
}

function ignores(globs: readonly Bun.Glob[], relativePath: string): boolean {
  return globs.some((glob) => glob.match(relativePath));
}

export const GlobExclusions = { compile, ignores };
