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
  await PimSettings.set("extensions", { toggles: {} });
});

describe("ExtensionToggles.gate", () => {
  test("skips a disabled extension and runs an enabled one", async () => {
    const calls: string[] = [];
    const factory = (name: string) => () => {
      calls.push(name);
    };
    await ExtensionToggles.setDisabled("web-search", true);

    await ExtensionToggles.gate(
      "web-search",
      factory("web-search")
    )({} as never);
    await ExtensionToggles.gate("bash", factory("bash"))({} as never);

    expect(calls).toEqual(["bash"]);
  });

  test("never skips a required extension", async () => {
    let ran = false;
    await PimSettings.set("extensions", { toggles: { _init: false } });

    await ExtensionToggles.gate("_init", () => {
      ran = true;
    })({} as never);

    expect(ran).toBe(true);
  });
});

describe("ExtensionToggles defaults", () => {
  test("todo and tps ship disabled and can be turned on", async () => {
    await expect(ExtensionToggles.disabled()).resolves.toEqual(["todo", "tps"]);

    await ExtensionToggles.setDisabled("todo", false);
    await ExtensionToggles.setDisabled("tps", false);

    await expect(ExtensionToggles.disabled()).resolves.toEqual([]);
    expect(await Bun.file(PimSettings.path()).json()).toMatchObject({
      extensions: { toggles: { todo: true, tps: true } },
    });
  });

  test("a toggle back to the default drops the entry", async () => {
    await ExtensionToggles.setDisabled("bash", true);
    await ExtensionToggles.setDisabled("bash", false);

    expect(await Bun.file(PimSettings.path()).json()).toMatchObject({
      extensions: { toggles: {} },
    });
  });
});

describe("ExtensionToggles settings", () => {
  test("persists a disable to pim's own settings file", async () => {
    await ExtensionToggles.setDisabled("web-search", true);

    expect(await Bun.file(PimSettings.path()).json()).toMatchObject({
      extensions: { toggles: { "web-search": false } },
    });
    await expect(ExtensionToggles.disabled()).resolves.toEqual([
      "todo",
      "tps",
      "web-search",
    ]);
    await expect(ExtensionToggles.isDisabled("web-search")).resolves.toBe(true);
    await expect(ExtensionToggles.isDisabled("bash")).resolves.toBe(false);
  });

  test("re-enabling removes the entry", async () => {
    await ExtensionToggles.setDisabled("bash", true);
    await ExtensionToggles.setDisabled("web-search", true);
    await ExtensionToggles.setDisabled("bash", false);

    await expect(ExtensionToggles.disabled()).resolves.toEqual([
      "todo",
      "tps",
      "web-search",
    ]);
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

  test("serializes concurrent writes instead of losing them", async () => {
    await Promise.all([
      ExtensionToggles.setDisabled("bash", true),
      ExtensionToggles.setDisabled("grep", true),
      ExtensionToggles.setDisabled("todo", false),
      ExtensionToggles.setDisabled("tps", false),
    ]);

    await expect(ExtensionToggles.disabled()).resolves.toEqual([
      "bash",
      "grep",
    ]);
  });

  test("refuses to disable required extensions", async () => {
    await expect(ExtensionToggles.setDisabled("_init", true)).rejects.toThrow(
      '"_init" is required by pim and cannot be disabled'
    );
    await expect(ExtensionToggles.toggle("pim")).rejects.toThrow(
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
      toggles: { "removed-extension": false, _init: false, grep: false },
    });

    await expect(ExtensionToggles.disabled()).resolves.toEqual([
      "grep",
      "todo",
      "tps",
    ]);
  });
});

describe("ExtensionToggles.NAMES", () => {
  test("matches the rosters wired in bin/pim.ts and CoreExtensions.ts", async () => {
    const sources = await Promise.all(
      [
        join(import.meta.dir, "../../../../bin/pim.ts"),
        join(import.meta.dir, "../extensions/CoreExtensions.ts"),
      ].map((path) => Bun.file(path).text())
    );
    const wired = sources.flatMap((source) =>
      [...source.matchAll(/\{ name: "([^"]+)", factory:/g)].map((m) => m[1])
    );

    expect(wired.sort()).toEqual([...ExtensionToggles.NAMES].sort());
  });
});
