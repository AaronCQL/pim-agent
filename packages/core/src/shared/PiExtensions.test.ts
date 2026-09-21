import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { usePimHome } from "./fixtures/home";
import { PiExtensions } from "./PiExtensions";
import { PimSettings } from "./PimSettings";

type PiSettings = {
  readonly extensions?: readonly string[];
  readonly packages?: readonly (
    | string
    | { readonly source: string; readonly extensions?: readonly string[] }
  )[];
};

const PACKAGE_SOURCE = "npm:pi-demo-pack";

let root: string;
let agentDir: string;
let cwd: string;
let scope: { readonly cwd: string; readonly agentDir: string };

usePimHome("pim-pi-extensions-home-");

const agentSettingsPath = () => join(agentDir, "settings.json");

async function agentSettings(): Promise<PiSettings> {
  return (await Bun.file(agentSettingsPath()).json()) as PiSettings;
}

async function entryFor(id: string) {
  return (await PiExtensions.list(scope)).find((entry) => entry.id === id);
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pim-pi-extensions-")));
  agentDir = join(root, "agent");
  cwd = join(root, "project");
  scope = { cwd, agentDir };

  await Bun.write(join(agentDir, "extensions/foo.ts"), "export default {};\n");
  await Bun.write(
    join(agentDir, "extensions/bar/index.ts"),
    "export default {};\n"
  );
  await Bun.write(
    join(agentDir, "npm/node_modules/pi-demo-pack/package.json"),
    `${JSON.stringify({
      name: "pi-demo-pack",
      version: "1.0.0",
      pi: { extensions: ["./index.js"] },
    })}\n`
  );
  await Bun.write(
    join(agentDir, "npm/node_modules/pi-demo-pack/index.js"),
    "export default {};\n"
  );
  await Bun.write(join(cwd, ".pi/extensions/proj.ts"), "export default {};\n");
  await Bun.write(
    join(cwd, ".pi/npm/node_modules/pi-demo-pack/package.json"),
    `${JSON.stringify({
      name: "pi-demo-pack",
      version: "1.0.0",
      pi: { extensions: ["./index.js"] },
    })}\n`
  );
  await Bun.write(
    join(cwd, ".pi/npm/node_modules/pi-demo-pack/index.js"),
    "export default {};\n"
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await PimSettings.set("extensions", { toggles: {} });
  await Bun.write(
    agentSettingsPath(),
    `${JSON.stringify({ packages: [PACKAGE_SOURCE] })}\n`
  );
  await rm(join(cwd, ".pi/settings.json"), { force: true });
});

describe("PiExtensions.list pim entries", () => {
  test("lists the allowlisted pim extensions and nothing else pim loads", async () => {
    const entries = await PiExtensions.list(scope);

    expect(
      entries
        .filter((entry) => entry.group === "pim")
        .map(({ id, label, enabled, writable }) => ({
          id,
          label,
          enabled,
          writable,
        }))
    ).toEqual([
      {
        id: "pim:todo",
        label: "Todo Tool",
        enabled: false,
        writable: true,
      },
    ]);
    expect(entries.some((entry) => entry.id === "pim:bash")).toBe(false);
    expect(entries.some((entry) => entry.id === "pim:write")).toBe(false);
    expect(entries.some((entry) => entry.id === "pim:tps")).toBe(false);
  });

  test("a pim toggle round-trips through pim's own settings file", async () => {
    await PiExtensions.setEnabled("pim:todo", true, scope);

    expect((await entryFor("pim:todo"))?.enabled).toBe(true);
    expect(await Bun.file(PimSettings.path()).json()).toMatchObject({
      extensions: { toggles: { todo: true } },
    });

    await PiExtensions.setEnabled("pim:todo", false, scope);

    expect((await entryFor("pim:todo"))?.enabled).toBe(false);
  });

  test("refuses a pim extension outside the allowlist", async () => {
    await expect(
      PiExtensions.setEnabled("pim:bash", false, scope)
    ).rejects.toThrow('Unknown extension "pim:bash"');
  });
});

describe("PiExtensions auto-discovered extensions", () => {
  test("lists a file in the agent extensions directory", async () => {
    const entry = await entryFor(`pi:${join(agentDir, "extensions/foo.ts")}`);

    expect(entry).toMatchObject({
      label: "foo",
      group: "user",
      enabled: true,
      writable: true,
    });
  });

  test("names a directory extension after its directory", async () => {
    const entry = await entryFor(
      `pi:${join(agentDir, "extensions/bar/index.ts")}`
    );

    expect(entry).toMatchObject({ label: "bar", group: "user" });
  });

  test("disabling writes a pattern and re-enabling replaces it", async () => {
    const id = `pi:${join(agentDir, "extensions/foo.ts")}`;

    await PiExtensions.setEnabled(id, false, scope);

    expect((await agentSettings()).extensions).toEqual(["-extensions/foo.ts"]);
    expect((await entryFor(id))?.enabled).toBe(false);

    await PiExtensions.setEnabled(id, true, scope);

    expect((await agentSettings()).extensions).toEqual(["+extensions/foo.ts"]);
    expect((await entryFor(id))?.enabled).toBe(true);
  });

  test("leaves other patterns alone", async () => {
    await Bun.write(
      agentSettingsPath(),
      `${JSON.stringify({ extensions: ["-extensions/bar/index.ts"] })}\n`
    );

    await PiExtensions.setEnabled(
      `pi:${join(agentDir, "extensions/foo.ts")}`,
      false,
      scope
    );

    expect((await agentSettings()).extensions).toEqual([
      "-extensions/bar/index.ts",
      "-extensions/foo.ts",
    ]);
  });
});

describe("PiExtensions package extensions", () => {
  test("resolves an installed package offline, without an install", async () => {
    const entry = await entryFor(
      `pi:${join(agentDir, "npm/node_modules/pi-demo-pack/index.js")}`
    );

    expect(entry).toMatchObject({
      label: "pi-demo-pack",
      group: "package",
      enabled: true,
      writable: true,
    });
  });

  test("disabling promotes the source string to a filtered entry", async () => {
    const id = `pi:${join(agentDir, "npm/node_modules/pi-demo-pack/index.js")}`;

    await PiExtensions.setEnabled(id, false, scope);

    expect((await agentSettings()).packages).toEqual([
      { source: PACKAGE_SOURCE, extensions: ["-index.js"] },
    ]);
    expect((await entryFor(id))?.enabled).toBe(false);

    await PiExtensions.setEnabled(id, true, scope);

    expect((await agentSettings()).packages).toEqual([
      { source: PACKAGE_SOURCE, extensions: ["+index.js"] },
    ]);
    expect((await entryFor(id))?.enabled).toBe(true);
  });
});

describe("PiExtensions.setEnabled refusals", () => {
  test("lists a project extension but will not switch it", async () => {
    const id = `pi:${join(cwd, ".pi/extensions/proj.ts")}`;

    expect(await entryFor(id)).toMatchObject({
      label: "proj",
      group: "project",
      writable: false,
    });
    await expect(PiExtensions.setEnabled(id, false, scope)).rejects.toThrow(
      "project-scoped"
    );
  });

  test("lists a package a project configured but will not switch it", async () => {
    await Bun.write(
      join(cwd, ".pi/settings.json"),
      `${JSON.stringify({ packages: [PACKAGE_SOURCE] })}\n`
    );
    const id = `pi:${join(cwd, ".pi/npm/node_modules/pi-demo-pack/index.js")}`;

    expect(await entryFor(id)).toMatchObject({
      group: "package",
      writable: false,
    });
    await expect(PiExtensions.setEnabled(id, false, scope)).rejects.toThrow(
      "project-scoped"
    );
  });

  test("refuses an unknown id", async () => {
    await expect(
      PiExtensions.setEnabled("pi:/nope/missing.ts", false, scope)
    ).rejects.toThrow('Unknown extension "pi:/nope/missing.ts"');
    await expect(
      PiExtensions.setEnabled("nonsense", false, scope)
    ).rejects.toThrow('Unknown extension "nonsense"');
  });
});

describe("PiExtensions.list ordering", () => {
  test("pim first, then package, user and project by label", async () => {
    const entries = await PiExtensions.list(scope);

    expect(entries.map((entry) => entry.label)).toEqual([
      "Todo Tool",
      "pi-demo-pack",
      "bar",
      "foo",
      "proj",
    ]);
  });
});
