import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { themeCliArgs } from "./themeCliArgs";

type Theme = { readonly name?: string; readonly sourcePath?: string };
type ThemeLoader = (themePath: string) => Theme;

// pi's exports map hides dist/modes/**, so import the loader by path.
const loadThemeFromPath = async (): Promise<ThemeLoader> => {
  const entry = fileURLToPath(
    import.meta.resolve("@earendil-works/pi-coding-agent")
  );
  const themeModule = join(dirname(entry), "modes/interactive/theme/theme.js");
  const loaded = (await import(themeModule)) as {
    readonly loadThemeFromPath: ThemeLoader;
  };
  return loaded.loadThemeFromPath;
};

const themesDir = (): string => {
  const [flag, dir] = themeCliArgs([]);
  expect(flag).toBe("--theme");
  expect(dir).toBeString();
  return dir as string;
};

test("a session run is themed and a pi subcommand is left alone", () => {
  expect(themeCliArgs(["--continue"])[0]).toBe("--theme");
  expect(themeCliArgs(["-p", "update the docs"])[0]).toBe("--theme");
  expect(themeCliArgs(["update", "--extensions"])).toBeEmpty();
  expect(themeCliArgs(["auth", "login"])).toBeEmpty();
  expect(themeCliArgs(["list"])).toBeEmpty();
  expect(themeCliArgs(["config"])).toBeEmpty();
  expect(themeCliArgs(["mcp", "list"])).toBeEmpty();
});

test("pi's theme loader accepts the directory and yields pim themes", async () => {
  const dir = themesDir();
  const load = await loadThemeFromPath();

  const themes = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => load(join(dir, name)));

  const names = themes.map((theme) => theme.name);
  expect(names).toContain("pim-dark");
  expect(names).toContain("pim-light");
});
