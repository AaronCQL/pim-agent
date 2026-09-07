import { describe, expect, test } from "bun:test";

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
