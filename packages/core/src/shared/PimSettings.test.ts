import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PimSettings } from "./PimSettings";

/**
 * Every test gets its own home, and so its own settings file: a test that
 * writes a key is otherwise the reason the test reading defaults passes or
 * fails, which is decided by the order they happen to run in.
 */
const VARS = [
  "EXA_API_KEY",
  "JINA_API_KEY",
  "FIRECRAWL_API_KEY",
  "PIM_HOME_DIR",
] as const;

let home = "";
let previous = new Map<string, string | undefined>();

beforeEach(async () => {
  previous = new Map(VARS.map((name) => [name, process.env[name]]));
  for (const name of VARS) {
    delete process.env[name];
  }
  home = await mkdtemp(join(tmpdir(), "pim-settings-home-"));
  process.env.PIM_HOME_DIR = home;
});

afterEach(async () => {
  for (const [name, value] of previous) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  await rm(home, { recursive: true, force: true });
});

describe("PimSettings", () => {
  test("loads defaults from ~/.pim/settings.json", async () => {
    expect(PimSettings.path()).toBe(join(home, "settings.json"));
    await expect(PimSettings.get("extensions")).resolves.toEqual({
      toggles: {},
    });
    await expect(PimSettings.get("exa")).resolves.toEqual({});
    await expect(PimSettings.get("jina")).resolves.toEqual({});
    await expect(PimSettings.get("firecrawl")).resolves.toEqual({});
    await expect(PimSettings.get("read")).resolves.toEqual({
      dedupImages: true,
    });
  });

  test("writes settings with private directory and file modes", async () => {
    await PimSettings.set("exa", { apiKey: "exa-test" });
    await PimSettings.set("jina", { apiKey: "jina-test" });
    await PimSettings.set("firecrawl", { apiKey: "firecrawl-test" });

    const path = PimSettings.path();
    expect(path).toBe(join(home, "settings.json"));
    expect(await Bun.file(path).json()).toEqual({
      extensions: { toggles: {} },
      exa: { apiKey: "exa-test" },
      jina: { apiKey: "jina-test" },
      firecrawl: { apiKey: "firecrawl-test" },
      read: { dedupImages: true },
    });

    expect((await stat(home)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("resolves API keys from env vars before settings", async () => {
    await PimSettings.set("exa", { apiKey: "exa-test" });
    await PimSettings.set("jina", { apiKey: "jina-test" });
    await PimSettings.set("firecrawl", { apiKey: "firecrawl-test" });

    await expect(PimSettings.getExaApiKey()).resolves.toBe("exa-test");
    await expect(PimSettings.getJinaApiKey()).resolves.toBe("jina-test");
    await expect(PimSettings.getFirecrawlApiKey()).resolves.toBe(
      "firecrawl-test"
    );

    process.env.EXA_API_KEY = "  exa-env  ";
    process.env.JINA_API_KEY = "";

    await expect(PimSettings.getExaApiKey()).resolves.toBe("exa-env");
    await expect(PimSettings.getJinaApiKey()).resolves.toBe("jina-test");
  });

  test("rejects invalid root setting values", async () => {
    await expect(
      PimSettings.set("exa", { apiKey: 123 } as never)
    ).rejects.toThrow('Invalid value for pim setting "exa"');
  });
});
