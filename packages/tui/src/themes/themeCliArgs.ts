// Pi reads its subcommand from argv[0] alone; prepending `--theme` turns these into prompts.
const PI_COMMANDS: ReadonlySet<string> = new Set([
  "auth",
  "client",
  "config",
  "install",
  "list",
  "mcp",
  "remove",
  "server",
  "uninstall",
  "update",
]);

export function themeCliArgs(argv: readonly string[]): readonly string[] {
  if (PI_COMMANDS.has(argv[0] ?? "")) {
    return [];
  }
  return ["--theme", Bun.fileURLToPath(new URL(".", import.meta.url))];
}
