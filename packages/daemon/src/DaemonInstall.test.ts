import { isAbsolute } from "node:path";
import { expect, test } from "bun:test";

import { SupersededUnits } from "#core/shared/DaemonUnit";
import { WebOptions } from "#server/WebOptions";
import { Config } from "#telegram/Config";
import { DaemonInstall, type Installed } from "./DaemonInstall";
import { Surfaces, type SurfaceName } from "./Surfaces";

type Case = readonly [string, ReadonlyArray<SurfaceName>];

/** What the daemon will read back out of its own unit file at boot. */
function frozen(argv: ReadonlyArray<string>): ReadonlyArray<string> {
  return DaemonInstall.unit(argv).args;
}

/** A daemon already installed with `argv`, as the next install reads it back. */
function serving(argv: ReadonlyArray<string>): Installed {
  const args = frozen(argv);
  return {
    surfaces: Surfaces.parse(args),
    args: args.map((arg) => (arg === "--web-cwd" ? "--cwd" : arg)),
  };
}

test("one unit replaces the two this install supersedes", () => {
  expect(DaemonInstall.unit(["--mode", "daemon"]).mode).toBe("daemon");
  expect(SupersededUnits.map((unit) => unit.mode)).toEqual(["web", "telegram"]);
});

test("the flags an install was given are frozen into the unit", () => {
  // A documentation address rather than `0.0.0.0`: binding this server to
  // every interface is the one thing it must never do, so it is not the
  // example a reader copies out of here.
  const args = frozen([
    "--mode",
    "daemon",
    "--port",
    "8080",
    "--hostname",
    "192.0.2.10",
    "--client-dir",
    "/srv/pim/client",
  ]);
  const cli = WebOptions.parse(args);

  expect(cli.port).toBe("8080");
  expect(cli.hostname).toBe("192.0.2.10");
  expect(cli.clientDir).toBe("/srv/pim/client");
});

test("`--flag=value` freezes the same as `--flag value`", () => {
  expect(WebOptions.parse(frozen(["--port=8080"])).port).toBe("8080");
});

test("a cwd nobody passed is still frozen to an explicit absolute path", () => {
  const cli = WebOptions.parse(frozen(["--mode", "daemon"]));

  expect(cli.cwd).toBe(process.cwd());
  expect(isAbsolute(cli.cwd)).toBe(true);
});

test("a relative cwd is resolved before it is frozen", () => {
  expect(WebOptions.parse(frozen(["--cwd", "."])).cwd).toBe(process.cwd());
});

// The two surfaces read one argv, and both would answer to `--cwd`: the bot's
// default directory is its own, and comes from its config file.
test("the web surface's cwd is frozen where the bot cannot mistake it for its own", () => {
  const args = frozen(["--mode", "daemon", "--cwd", "/srv/web"]);

  expect(args).toContain("--web-cwd");
  expect(args).not.toContain("--cwd");
  expect(Config.parseArgs(args).cwd).toBeUndefined();
  expect(WebOptions.parse(args).cwd).toBe("/srv/web");
});

test("the install flags themselves do not reach the daemon", () => {
  const args = frozen(["--mode", "daemon", "--install", "--port", "8080"]);

  expect(args).not.toContain("--install");
  expect(args).not.toContain("--uninstall");
  expect(args).not.toContain("--mode");
  expect(WebOptions.parse(args).port).toBe("8080");
});

test.each<Case>([
  ["web", ["web"]],
  ["telegram", ["telegram"]],
  ["daemon", ["web", "telegram"]],
])("--mode %s installs a unit that serves %p", (mode, expected) => {
  const args = frozen(["--mode", mode]);

  expect(Surfaces.parse(args)).toEqual(expected);
  expect(args.slice(0, 2)).toEqual(["--surfaces", expected.join(",")]);
});

test("a telegram-only install freezes no port, hostname or client directory", () => {
  expect(frozen(["--mode", "telegram", "--port", "8080"])).toEqual([
    "--surfaces",
    "telegram",
  ]);
});

test("the unit's description names the surfaces it serves", () => {
  expect(DaemonInstall.unit(["--mode", "telegram"]).description).toBe(
    "Pim daemon (telegram)"
  );
});

// `--mode web --install` and `--mode telegram --install` were the two flows the
// README documented, run months apart. One unit now serves both, so the second
// must not silently stop being the first.
test("installing one surface keeps the one the daemon already serves", () => {
  const installed = serving(["--mode", "web", "--hostname", "100.64.0.1"]);
  const merged = DaemonInstall.unit(["--mode", "telegram"], installed).args;

  expect(Surfaces.parse(merged)).toEqual(["web", "telegram"]);
  expect(WebOptions.parse(merged).hostname).toBe("100.64.0.1");
});

test("naming --surfaces outright is how a daemon is shrunk again", () => {
  const merged = DaemonInstall.unit(
    ["--surfaces", "telegram"],
    serving(["--mode", "daemon"])
  ).args;

  expect(Surfaces.parse(merged)).toEqual(["telegram"]);
});

test("a flag the re-install names outranks the one frozen before it", () => {
  const installed = serving(["--mode", "web", "--port", "8080", "--cwd", "/a"]);
  const merged = DaemonInstall.unit(
    ["--mode", "web", "--cwd", "/b"],
    installed
  ).args;
  const cli = WebOptions.parse(merged);

  expect(cli.cwd).toBe("/b");
  expect(cli.port).toBe("8080");
});

// The cutover: two units are already running, and their flags are all the
// install has to go on unless the operator names new ones.
test("the merged unit inherits what the per-surface units were installed with", () => {
  const installed: Installed = {
    surfaces: ["web", "telegram"],
    args: [
      "--mode",
      "web",
      "--port",
      "4319",
      "--hostname",
      "100.64.0.1",
      "--cwd",
      "/srv/pim",
      "--mode",
      "telegram",
    ],
  };
  const merged = DaemonInstall.unit(["--mode", "daemon"], installed).args;
  const cli = WebOptions.parse(merged);

  expect(Surfaces.parse(merged)).toEqual(["web", "telegram"]);
  expect(cli.hostname).toBe("100.64.0.1");
  expect(cli.cwd).toBe("/srv/pim");
  expect(merged).not.toContain("--cwd");
});
