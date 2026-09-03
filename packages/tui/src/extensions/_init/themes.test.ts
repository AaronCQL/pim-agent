import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import init from "./index";

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

const discoverThemePaths = async (): Promise<readonly string[]> => {
  type Handler = (event: unknown, ctx: unknown) => unknown;
  const handlers = new Map<string, Handler>();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand() {},
  } as unknown as ExtensionAPI;

  await init(pi);

  const handler = handlers.get("resources_discover");
  expect(handler).toBeFunction();

  // pi calls the handler with (event, ctx); this one reads neither.
  const result = (handler as Handler)({}, {}) as {
    readonly themePaths?: readonly string[];
  };
  return result?.themePaths ?? [];
};

test("_init discovers a themes directory that exists on disk", async () => {
  const themePaths = await discoverThemePaths();

  expect(themePaths).toHaveLength(1);

  const [themesDir] = themePaths;
  expect(themesDir).toBeString();
  const entries = readdirSync(themesDir as string);
  expect(entries).toContain("pim-dark.json");
  expect(entries).toContain("pim-light.json");
});

test("every discovered theme file parses as JSON", async () => {
  const [themesDir] = await discoverThemePaths();
  const files = readdirSync(themesDir as string).filter((name) =>
    name.endsWith(".json")
  );

  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const parsed = await Bun.file(join(themesDir as string, file)).json();
    expect(parsed).toBeObject();
  }
});

// Highest-fidelity check: run pi's own loader over the discovered directory the
// same way ResourceLoader.loadThemesFromDir does, so a malformed theme (missing
// colors, bad name) fails here exactly as it would fail at startup.
test("pi's theme loader accepts the discovered directory and yields pim themes", async () => {
  const [themesDir] = await discoverThemePaths();
  const load = await loadThemeFromPath();

  const themes = readdirSync(themesDir as string)
    .filter((name) => name.endsWith(".json"))
    .map((name) => load(join(themesDir as string, name)));

  const names = themes.map((theme) => theme.name);
  expect(names).toContain("pim-dark");
  expect(names).toContain("pim-light");
});
