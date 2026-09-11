import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PimSettings } from "./PimSettings";

let previousExaApiKey: string | undefined;
let previousJinaApiKey: string | undefined;
let previousFirecrawlApiKey: string | undefined;
let previousPimHomeDir: string | undefined;
let testPimHomeDir: string | undefined;

beforeAll(async () => {
  previousExaApiKey = process.env.EXA_API_KEY;
  previousJinaApiKey = process.env.JINA_API_KEY;
  previousFirecrawlApiKey = process.env.FIRECRAWL_API_KEY;
  previousPimHomeDir = process.env.PIM_HOME_DIR;
  testPimHomeDir = await mkdtemp(join(tmpdir(), "pim-settings-home-"));
  delete process.env.EXA_API_KEY;
  delete process.env.JINA_API_KEY;
  delete process.env.FIRECRAWL_API_KEY;
  process.env.PIM_HOME_DIR = testPimHomeDir;
});

afterAll(async () => {
  if (previousExaApiKey === undefined) {
    delete process.env.EXA_API_KEY;
  } else {
    process.env.EXA_API_KEY = previousExaApiKey;
  }
  if (previousJinaApiKey === undefined) {
    delete process.env.JINA_API_KEY;
  } else {
    process.env.JINA_API_KEY = previousJinaApiKey;
  }
  if (previousFirecrawlApiKey === undefined) {
    delete process.env.FIRECRAWL_API_KEY;
  } else {
    process.env.FIRECRAWL_API_KEY = previousFirecrawlApiKey;
  }
  if (previousPimHomeDir === undefined) {
    delete process.env.PIM_HOME_DIR;
  } else {
    process.env.PIM_HOME_DIR = previousPimHomeDir;
  }
  if (testPimHomeDir) {
    await rm(testPimHomeDir, { recursive: true, force: true });
  }
});

describe("PimSettings", () => {
  test("loads defaults from ~/.pim/settings.json", async () => {
    expect(PimSettings.path()).toBe(join(testPimHomeDir!, "settings.json"));
    await expect(PimSettings.get("extensions")).resolves.toEqual({
      toggles: {},
    });
    await expect(PimSettings.get("exa")).resolves.toEqual({});
    await expect(PimSettings.get("jina")).resolves.toEqual({});
    await expect(PimSettings.get("firecrawl")).resolves.toEqual({});
  });

  test("writes settings with private directory and file modes", async () => {
    await PimSettings.set("exa", { apiKey: "exa-test" });
    await PimSettings.set("jina", { apiKey: "jina-test" });
    await PimSettings.set("firecrawl", { apiKey: "firecrawl-test" });

    const path = PimSettings.path();
    expect(path).toBe(join(testPimHomeDir!, "settings.json"));
    expect(await Bun.file(path).json()).toEqual({
      extensions: { toggles: {} },
      exa: { apiKey: "exa-test" },
      jina: { apiKey: "jina-test" },
      firecrawl: { apiKey: "firecrawl-test" },
    });

    expect((await stat(testPimHomeDir!)).mode & 0o777).toBe(0o700);
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
