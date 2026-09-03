/**
 * Pi registers themes while the resource loader runs, which is before the
 * interactive theme controller applies the saved setting. `resources_discover`
 * fires later than both, so a saved `pim-dark` resolved to nothing and pi fell
 * back to `dark` with an error. `--theme` is the only channel that lands early
 * enough, and it is per-run: nothing reaches the user's pi settings.
 */
export function themeCliArgs(): readonly string[] {
  return ["--theme", Bun.fileURLToPath(new URL(".", import.meta.url))];
}
