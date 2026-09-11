import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DaemonUnit, SupersededUnits } from "./DaemonUnit";
import { Supervisor, type Install, type Unit } from "./Supervisor";

const at: Install = {
  kind: "prod",
  packageRoot: "/opt/pim",
  pimEntry: "/opt/pim/bin/pim.ts",
  bunPath: "/opt/bun/bin/bun",
};

const telegram: Unit = { mode: "telegram", description: "Pim Telegram daemon" };
const web: Unit = {
  mode: "web",
  description: "Pim web daemon",
  args: ["--port", "8080"],
};
const daemon: Unit = {
  mode: "daemon",
  description: "Pim daemon",
  args: ["--surfaces", "web,telegram", "--port", "8080"],
};

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pim-supervisor-test-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function installUnit(unit: Unit, platform: NodeJS.Platform) {
  const path = Supervisor.unitFile(unit, { platform, home });
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "");
  return path;
}

describe("systemdUnit", () => {
  test("names the unit's description and starts it in its own mode", () => {
    const text = Supervisor.systemdUnit(telegram, at);
    expect(text).toContain("Description=Pim Telegram daemon");
    expect(text).toContain(
      "ExecStart=/opt/bun/bin/bun /opt/pim/bin/pim.ts --mode telegram\n"
    );
    expect(text).toContain(
      "Environment=PATH=/opt/bun/bin:/usr/local/bin:/usr/bin:/bin"
    );
  });

  test("marks the process supervised, so exiting is a restart", () => {
    expect(Supervisor.systemdUnit(telegram, at)).toContain(
      "Environment=PIM_SUPERVISED=1"
    );
  });

  test("appends the unit's extra arguments after the mode", () => {
    expect(Supervisor.systemdUnit(web, at)).toContain(
      "ExecStart=/opt/bun/bin/bun /opt/pim/bin/pim.ts --mode web --port 8080\n"
    );
  });
});

describe("launchdPlist", () => {
  test("labels and logs per unit, one argv string per argument", () => {
    const text = Supervisor.launchdPlist(telegram, at);
    expect(text).toContain("<string>com.aaroncql.pim-telegram</string>");
    expect(text).toContain("Library/Logs/pim-telegram.log</string>");
    expect(text).toContain(
      [
        "    <string>/opt/bun/bin/bun</string>",
        "    <string>/opt/pim/bin/pim.ts</string>",
        "    <string>--mode</string>",
        "    <string>telegram</string>",
        "  </array>",
      ].join("\n")
    );
  });

  test("marks the process supervised, so exiting is a restart", () => {
    expect(Supervisor.launchdPlist(telegram, at)).toContain(
      [
        "    <key>PIM_SUPERVISED</key>",
        "    <string>1</string>",
        "  </dict>",
      ].join("\n")
    );
  });

  test("appends the unit's extra arguments after the mode", () => {
    const text = Supervisor.launchdPlist(web, at);
    expect(text).toContain("<string>com.aaroncql.pim-web</string>");
    expect(text).toContain("Library/Logs/pim-web.log</string>");
    expect(text).toContain(
      [
        "    <string>--mode</string>",
        "    <string>web</string>",
        "    <string>--port</string>",
        "    <string>8080</string>",
        "  </array>",
      ].join("\n")
    );
  });
});

describe("superseding the per-surface units", () => {
  test("finds only the old units this machine actually has", async () => {
    await installUnit(SupersededUnits[0]!, "linux");

    const found = await Supervisor.installedAmong(SupersededUnits, {
      platform: "linux",
      home,
    });

    expect(found.map((unit) => unit.mode)).toEqual(["web"]);
  });

  test("finds nothing when the old units were never installed", async () => {
    expect(
      await Supervisor.installedAmong(SupersededUnits, {
        platform: "linux",
        home,
      })
    ).toEqual([]);
  });

  test("finds a launchd unit by its plist", async () => {
    await installUnit(SupersededUnits[1]!, "darwin");

    const found = await Supervisor.installedAmong(SupersededUnits, {
      platform: "darwin",
      home,
    });

    expect(found.map((unit) => unit.mode)).toEqual(["telegram"]);
  });

  test("the merged unit is not one of the units it supersedes", () => {
    expect(SupersededUnits.map((unit) => unit.mode)).not.toContain(
      DaemonUnit.mode
    );
  });

  test("systemd removal stops before it disables, and reloads after the file is gone", () => {
    const steps = Supervisor.uninstallSteps(web, { platform: "linux", home });

    expect(steps).toEqual([
      { kind: "run", cmd: ["systemctl", "--user", "stop", "pim-web"] },
      { kind: "run", cmd: ["systemctl", "--user", "disable", "pim-web"] },
      {
        kind: "remove",
        path: join(home, ".config/systemd/user/pim-web.service"),
      },
      { kind: "run", cmd: ["systemctl", "--user", "daemon-reload"] },
    ]);
  });

  test("launchd removal boots the label out before the plist goes", () => {
    const uid = process.getuid?.() ?? 0;
    const steps = Supervisor.uninstallSteps(telegram, {
      platform: "darwin",
      home,
    });

    expect(steps).toEqual([
      {
        kind: "run",
        cmd: ["launchctl", "bootout", `gui/${uid}/com.aaroncql.pim-telegram`],
      },
      {
        kind: "remove",
        path: join(
          home,
          "Library/LaunchAgents/com.aaroncql.pim-telegram.plist"
        ),
      },
    ]);
  });
});

describe("installedArgs", () => {
  test.each([
    ["linux" as const, () => Supervisor.systemdUnit(daemon, at)],
    ["darwin" as const, () => Supervisor.launchdPlist(daemon, at)],
  ])("reads back the argv it wrote into a %s unit", async (platform, write) => {
    const path = Supervisor.unitFile(daemon, { platform, home });
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, write());

    expect(await Supervisor.installedArgs(daemon, { platform, home })).toEqual([
      "--mode",
      "daemon",
      "--surfaces",
      "web,telegram",
      "--port",
      "8080",
    ]);
  });

  test("reads nothing out of a unit that is not installed", async () => {
    expect(
      await Supervisor.installedArgs(daemon, { platform: "linux", home })
    ).toEqual([]);
  });
});
