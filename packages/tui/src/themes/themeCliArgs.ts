// Pi reads its subcommand from argv[0] alone, so anything placed in front of
// one turns it back into a prompt: `update --extensions` died on the unknown
// flag, and `list` quietly spent a turn asking the model for a listing.
// Appending is no better — the package parser rejects `--theme` as an unknown
// option — so a command run simply gets no theme.
const PI_COMMANDS: ReadonlySet<string> = new Set([
  "auth",
  "client",
  "config",
  "install",
  "list",
  "remove",
  "server",
  "uninstall",
  "update",
]);

/**
 * Pi registers themes while the resource loader runs, which is before the
 * interactive theme controller applies the saved setting. `resources_discover`
 * fires later than both, so a saved `pim-dark` resolved to nothing and pi fell
 * back to `dark` with an error. `--theme` is the only channel that lands early
 * enough, and it is per-run: nothing reaches the user's pi settings.
 */
export function themeCliArgs(argv: readonly string[]): readonly string[] {
  if (PI_COMMANDS.has(argv[0] ?? "")) {
    return [];
  }
  return ["--theme", Bun.fileURLToPath(new URL(".", import.meta.url))];
}
