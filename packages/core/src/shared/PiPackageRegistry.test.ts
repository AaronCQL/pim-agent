import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PiPackageRegistry } from "./PiPackageRegistry";

const PIM = "@aaroncql/pim-agent";

async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "pim-registry-"));
}

/** A package root that looks installed, so the checkout guard stays open. */
async function installedRoot(dir: string): Promise<string> {
  const root = join(dir, "node_modules", PIM);
  await Bun.write(join(root, "package.json"), JSON.stringify({ name: PIM }));
  return root;
}

async function register(
  dir: string,
  settings: unknown,
  root: string
): Promise<{ readonly wrote: boolean; readonly packages: unknown }> {
  const settingsPath = join(dir, "settings.json");
  if (settings !== undefined) {
    await Bun.write(settingsPath, JSON.stringify(settings, null, 2));
  }
  const wrote = await PiPackageRegistry.ensureSelfRegistered({
    settingsPath,
    agentDir: dir,
    packageName: PIM,
    packageRoot: root,
  });
  const written = (await Bun.file(settingsPath).json()) as {
    readonly packages?: unknown;
  };
  return { wrote, packages: written.packages };
}

describe("isInstalledPackage", () => {
  test("a node_modules ancestor means installed", () => {
    expect(
      PiPackageRegistry.isInstalledPackage("/home/u/.bun/node_modules/@a/pim")
    ).toBe(true);
  });

  test("a bare checkout is not", () => {
    expect(PiPackageRegistry.isInstalledPackage("/home/u/dev/pim-agent")).toBe(
      false
    );
  });
});

describe("parseNpmName", () => {
  test.each([
    ["npm:@aaroncql/pim-agent", PIM],
    ["npm:@aaroncql/pim-agent@0.8.0", PIM],
    ["npm:pi-hashline-edit", "pi-hashline-edit"],
    ["../../dev/pim-agent", undefined],
    ["https://github.com/a/b", undefined],
  ])("%s", (source, expected) => {
    expect(PiPackageRegistry.parseNpmName(source)).toBe(expected as never);
  });
});

describe("ensureSelfRegistered", () => {
  test("adds its own path and preserves other settings", async () => {
    const dir = await scratch();
    const root = await installedRoot(dir);
    const { wrote, packages } = await register(
      dir,
      { theme: "pim-dark", packages: ["npm:other"] },
      root
    );

    expect(wrote).toBe(true);
    expect(packages).toEqual(["npm:other", root]);
    expect(
      ((await Bun.file(join(dir, "settings.json")).json()) as { theme: string })
        .theme
    ).toBe("pim-dark");
  });

  test("creates a packages list when settings has none", async () => {
    const dir = await scratch();
    const root = await installedRoot(dir);
    const { wrote, packages } = await register(
      dir,
      { theme: "pim-dark" },
      root
    );

    expect(wrote).toBe(true);
    expect(packages).toEqual([root]);
  });

  // Users who ran the old `pi install npm:@aaroncql/pim-agent` keep that entry;
  // adding a path entry too would load every extension twice.
  test("is a no-op when the npm identity is already registered", async () => {
    const dir = await scratch();
    const { wrote, packages } = await register(
      dir,
      { packages: [`npm:${PIM}`] },
      await installedRoot(dir)
    );

    expect(wrote).toBe(false);
    expect(packages).toEqual([`npm:${PIM}`]);
  });

  test("a pinned version still counts as registered", async () => {
    const dir = await scratch();
    const { wrote } = await register(
      dir,
      { packages: [`npm:${PIM}@0.7.0`] },
      await installedRoot(dir)
    );

    expect(wrote).toBe(false);
  });

  // The case on a maintainer's machine: a checkout registered globally by
  // relative path. Adding `npm:` too would load every extension twice.
  test("a local entry pointing at this package counts as registered", async () => {
    const dir = await scratch();
    const checkout = join(dir, "checkout");
    await Bun.write(
      join(checkout, "package.json"),
      JSON.stringify({ name: PIM })
    );

    const { wrote } = await register(
      dir,
      { packages: [{ source: "checkout", extensions: ["+src/x.ts"] }] },
      await installedRoot(dir)
    );

    expect(wrote).toBe(false);
  });

  test("an unrelated local entry does not count", async () => {
    const dir = await scratch();
    const other = join(dir, "other");
    await Bun.write(
      join(other, "package.json"),
      JSON.stringify({ name: "pi-something-else" })
    );

    const { wrote } = await register(
      dir,
      { packages: ["other"] },
      await installedRoot(dir)
    );

    expect(wrote).toBe(true);
  });

  test("skips a checkout, which pi must not resolve to a published copy", async () => {
    const dir = await scratch();
    const checkout = join(dir, "pim-agent");
    await Bun.write(
      join(checkout, "package.json"),
      JSON.stringify({ name: PIM })
    );

    const settingsPath = join(dir, "settings.json");
    await Bun.write(settingsPath, JSON.stringify({}));
    const wrote = await PiPackageRegistry.ensureSelfRegistered({
      settingsPath,
      agentDir: dir,
      packageName: PIM,
      packageRoot: checkout,
    });

    expect(wrote).toBe(false);
  });

  test("malformed settings never blocks the launcher", async () => {
    const dir = await scratch();
    const settingsPath = join(dir, "settings.json");
    await Bun.write(settingsPath, "{ not json");

    const wrote = await PiPackageRegistry.ensureSelfRegistered({
      settingsPath,
      agentDir: dir,
      packageName: PIM,
      packageRoot: await installedRoot(dir),
    });

    expect(wrote).toBe(false);
    expect(await Bun.file(settingsPath).text()).toBe("{ not json");
  });
});

describe("resolveAgentDir", () => {
  test("defaults to ~/.pi/agent", () => {
    expect(PiPackageRegistry.resolveAgentDir({ HOME: "/home/u" })).toBe(
      "/home/u/.pi/agent"
    );
  });

  test("honours the override, including a tilde", () => {
    expect(
      PiPackageRegistry.resolveAgentDir({
        HOME: "/home/u",
        PI_CODING_AGENT_DIR: "~/alt",
      })
    ).toBe("/home/u/alt");
    expect(
      PiPackageRegistry.resolveAgentDir({
        HOME: "/home/u",
        PI_CODING_AGENT_DIR: "/srv/pi",
      })
    ).toBe("/srv/pi");
  });
});
