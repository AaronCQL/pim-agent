import { isAbsolute } from "node:path";
import { expect, test } from "bun:test";

import { WebOptions } from "#server/WebOptions";
import { Config } from "#telegram/Config";
import { DaemonInstall, type Installed } from "./DaemonInstall";
import { Surfaces, type SurfaceName } from "./Surfaces";

type Case = readonly [string, ReadonlyArray<SurfaceName>];

function frozen(argv: ReadonlyArray<string>): ReadonlyArray<string> {
  return DaemonInstall.unit(argv).args;
}

function serving(argv: ReadonlyArray<string>): Installed {
  const args = frozen(argv);
  return {
    surfaces: Surfaces.parse(args),
    args: args.map((arg) => (arg === "--web-cwd" ? "--cwd" : arg)),
  };
}

test("the flags an install was given are frozen into the unit", () => {
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

test("the web surface's cwd is frozen as --web-cwd so the bot ignores it", () => {
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
