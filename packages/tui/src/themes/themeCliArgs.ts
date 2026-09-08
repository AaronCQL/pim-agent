// Pi reads its subcommand from argv[0] alone; prepending `--theme` turns these into prompts.
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

/** Per-run `--theme` args: the only channel early enough for pim's themes to resolve. */
export function themeCliArgs(argv: readonly string[]): readonly string[] {
  if (PI_COMMANDS.has(argv[0] ?? "")) {
    return [];
  }
  return ["--theme", Bun.fileURLToPath(new URL(".", import.meta.url))];
}
