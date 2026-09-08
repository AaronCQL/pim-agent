/**
 * Tolerant on purpose: the same argv reaches every mode through `pim --mode x`,
 * so unknown flags and the mode positional must not be fatal. `take()` accepts
 * both `--k v` and `--k=v`; whether a key consumes a value is the caller's
 * decision, made by calling `take` or not.
 */
function scan(
  args: ReadonlyArray<string>,
  visit: (key: string, take: () => string | undefined) => void
): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      continue;
    }
    const eqIdx = arg.indexOf("=");
    const key = eqIdx >= 0 ? arg.slice(0, eqIdx) : arg;
    const inline = eqIdx >= 0 ? arg.slice(eqIdx + 1) : undefined;

    visit(key, () => {
      if (inline !== undefined) {
        return inline;
      }
      i += 1;
      return args[i];
    });
  }
}

export const Cli = { scan };
