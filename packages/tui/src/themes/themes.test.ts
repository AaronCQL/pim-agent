import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { themeCliArgs } from "./themeCliArgs";

type Theme = { readonly name?: string; readonly sourcePath?: string };
type ThemeLoader = (themePath: string) => Theme;

// The exports map hides dist/modes/**, so reach pi's real loader by locating the
// package entry and walking to the sibling file the resource loader itself uses.
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
  const [flag, dir] = themeCliArgs();
  expect(flag).toBe("--theme");
  expect(dir).toBeString();
  return dir as string;
};

test("the theme args point pi at a themes directory that exists on disk", () => {
  const entries = readdirSync(themesDir());

  expect(entries).toContain("pim-dark.json");
  expect(entries).toContain("pim-light.json");
});

test("every theme file parses as JSON", async () => {
  const dir = themesDir();
  const files = readdirSync(dir).filter((name) => name.endsWith(".json"));

  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const parsed = await Bun.file(join(dir, file)).json();
    expect(parsed).toBeObject();
  }
});

// Highest-fidelity check: run pi's own loader over the directory the same way
// ResourceLoader.loadThemesFromDir does, so a malformed theme (missing colors,
// bad name) fails here exactly as it would fail at startup.
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
