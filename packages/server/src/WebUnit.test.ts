import { isAbsolute } from "node:path";
import { expect, test } from "bun:test";

import { parseArgs } from "./serve";
import { WebUnit } from "./WebUnit";

/** What the daemon will read back out of its own unit file at boot. */
function frozen(argv: ReadonlyArray<string>): ReturnType<typeof parseArgs> {
  return parseArgs(WebUnit.unit(argv).args);
}

test("the flags an install was given are frozen into the unit", () => {
  // A documentation address rather than `0.0.0.0`: binding this server to
  // every interface is the one thing it must never do, so it is not the
  // example a reader copies out of here.
  const cli = frozen([
    "--mode",
    "web",
    "--port",
    "8080",
    "--hostname",
    "192.0.2.10",
    "--client-dir",
    "/srv/pim/client",
  ]);

  expect(cli.port).toBe("8080");
  expect(cli.hostname).toBe("192.0.2.10");
  expect(cli.clientDir).toBe("/srv/pim/client");
});

test("`--flag=value` freezes the same as `--flag value`", () => {
  expect(frozen(["--port=8080"]).port).toBe("8080");
});

test("a cwd nobody passed is still frozen to an explicit absolute path", () => {
  const cli = frozen(["--mode", "web"]);

  expect(cli.cwd).toBe(process.cwd());
  expect(isAbsolute(cli.cwd)).toBe(true);
});

test("a relative cwd is resolved before it is frozen", () => {
  expect(frozen(["--cwd", "."]).cwd).toBe(process.cwd());
});

test("the install flags themselves do not reach the daemon", () => {
  const args = WebUnit.unit([
    "--mode",
    "web",
    "--install",
    "--port",
    "8080",
  ]).args;

  expect(args).not.toContain("--install");
  expect(args).not.toContain("--uninstall");
  expect(args).not.toContain("--mode");
  expect(parseArgs(args).port).toBe("8080");
});
