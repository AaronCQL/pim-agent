import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionToggles } from "./ExtensionToggles";
import { PimSettings } from "./PimSettings";

let previousPimHomeDir: string | undefined;
let homeDir: string;

beforeAll(async () => {
  previousPimHomeDir = process.env.PIM_HOME_DIR;
  homeDir = await mkdtemp(join(tmpdir(), "pim-toggles-home-"));
  process.env.PIM_HOME_DIR = homeDir;
});

afterAll(async () => {
  if (previousPimHomeDir === undefined) {
    delete process.env.PIM_HOME_DIR;
  } else {
    process.env.PIM_HOME_DIR = previousPimHomeDir;
  }
  await rm(homeDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await PimSettings.set("extensions", { disabled: [] });
});

describe("ExtensionToggles.filter", () => {
  const factories = [
    { name: "_init" },
    { name: "bash" },
    { name: "web-search" },
  ] as const;

  test("drops disabled extensions", () => {
    expect(ExtensionToggles.filter(factories, ["web-search"])).toEqual([
      { name: "_init" },
      { name: "bash" },
    ]);
  });

  test("keeps everything when nothing is disabled", () => {
    expect(ExtensionToggles.filter(factories, [])).toEqual([...factories]);
  });

  test("never drops required extensions", () => {
    expect(
      ExtensionToggles.filter(factories, [
        "_init",
        "extension-toggle",
        "bash",
      ]).map((e) => e.name)
    ).toEqual(["_init", "web-search"]);
  });
});

describe("ExtensionToggles settings", () => {
  test("persists a disable to pim's own settings file", async () => {
    await ExtensionToggles.setDisabled("web-search", true);

    expect(await Bun.file(PimSettings.path()).json()).toMatchObject({
      extensions: { disabled: ["web-search"] },
    });
    await expect(ExtensionToggles.disabled()).resolves.toEqual(["web-search"]);
    await expect(ExtensionToggles.isDisabled("web-search")).resolves.toBe(true);
    await expect(ExtensionToggles.isDisabled("bash")).resolves.toBe(false);
  });

  test("re-enabling removes the entry", async () => {
    await ExtensionToggles.setDisabled("bash", true);
    await ExtensionToggles.setDisabled("web-search", true);
    await ExtensionToggles.setDisabled("bash", false);

    await expect(ExtensionToggles.disabled()).resolves.toEqual(["web-search"]);
  });

  test("disabling twice does not duplicate", async () => {
    await ExtensionToggles.setDisabled("bash", true);
    await ExtensionToggles.setDisabled("bash", true);

    await expect(ExtensionToggles.disabled()).resolves.toEqual(["bash"]);
  });

  test("toggle flips and reports the new state", async () => {
    await expect(ExtensionToggles.toggle("grep")).resolves.toEqual({
      name: "grep",
      disabled: true,
    });
    await expect(ExtensionToggles.toggle("grep")).resolves.toEqual({
      name: "grep",
      disabled: false,
    });
  });

  test("refuses to disable required extensions", async () => {
    await expect(ExtensionToggles.setDisabled("_init", true)).rejects.toThrow(
      '"_init" is required by pim and cannot be disabled'
    );
    await expect(ExtensionToggles.toggle("extension-toggle")).rejects.toThrow(
      "cannot be disabled"
    );
  });

  test("refuses unknown names", async () => {
    await expect(ExtensionToggles.setDisabled("nope", true)).rejects.toThrow(
      'Unknown pim extension "nope"'
    );
  });

  test("ignores stale names left in the settings file", async () => {
    await PimSettings.set("extensions", {
      disabled: ["removed-extension", "_init", "todo"],
    });

    await expect(ExtensionToggles.disabled()).resolves.toEqual(["todo"]);
  });
});

describe("ExtensionToggles.NAMES", () => {
  test("matches the roster wired in bin/pim.ts", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "../../../../bin/pim.ts")
    ).text();
    const wired = [...source.matchAll(/\{ name: "([^"]+)", factory:/g)].map(
      (m) => m[1]
    );

    expect(wired.sort()).toEqual([...ExtensionToggles.NAMES].sort());
  });
});
