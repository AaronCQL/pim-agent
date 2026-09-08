import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { Fs } from "./Fs";
import { Proc } from "./Proc";

/**
 * Set by the units this file writes, and by nothing else: it is how a daemon
 * knows that exiting will bring it back rather than just end it.
 */
const SUPERVISED_ENV = "PIM_SUPERVISED";

/** One daemon the supervisor manages, named by the `--mode` it is started with. */
export type Unit = {
  readonly mode: string;
  readonly description: string;
  readonly args?: ReadonlyArray<string>;
};

export type Install = {
  readonly kind: "dev" | "prod";
  readonly packageRoot: string;
  readonly pimEntry: string;
  readonly bunPath: string;
};

async function install(unit: Unit): Promise<void> {
  const at = await detectInstall();
  console.log(`[install] ${at.kind} mode, root=${at.packageRoot}`);
  if (process.platform === "linux") {
    const path = systemdUnitPath(unit);
    await Fs.writeAtomic(path, systemdUnit(unit, at));
    console.log(`[install] wrote ${path}`);
    await runOrThrow(["systemctl", "--user", "daemon-reload"]);
    await runOrThrow([
      "systemctl",
      "--user",
      "enable",
      "--now",
      unitName(unit),
    ]);
    console.log(`[install] enabled and started ${unitName(unit)}.service`);
    if (!(await lingerEnabled())) {
      console.log(
        `[install] hint: run 'loginctl enable-linger' so the service starts at boot without an active login`
      );
    }
    return;
  }
  if (process.platform === "darwin") {
    await mkdir(join(homedir(), "Library", "Logs"), { recursive: true });
    const path = launchdPlistPath(unit);
    await Fs.writeAtomic(path, launchdPlist(unit, at));
    console.log(`[install] wrote ${path}`);
    const uid = process.getuid?.() ?? 0;
    try {
      await runOrThrow([
        "launchctl",
        "bootout",
        `gui/${uid}/${launchdLabel(unit)}`,
      ]);
    } catch {
      // bootout fails when the service isn't currently loaded; safe to ignore before bootstrap
    }
    await runOrThrow(["launchctl", "bootstrap", `gui/${uid}`, path]);
    console.log(`[install] bootstrapped ${launchdLabel(unit)}`);
    return;
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}

async function uninstall(unit: Unit): Promise<void> {
  if (process.platform === "linux") {
    const path = systemdUnitPath(unit);
    try {
      await runOrThrow([
        "systemctl",
        "--user",
        "disable",
        "--now",
        unitName(unit),
      ]);
    } catch (err) {
      console.warn(`[uninstall] disable failed:`, (err as Error).message);
    }
    try {
      await rm(path);
      console.log(`[uninstall] removed ${path}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
    try {
      await runOrThrow(["systemctl", "--user", "daemon-reload"]);
    } catch (err) {
      console.warn(`[uninstall] daemon-reload failed:`, (err as Error).message);
    }
    return;
  }
  if (process.platform === "darwin") {
    const path = launchdPlistPath(unit);
    const uid = process.getuid?.() ?? 0;
    try {
      await runOrThrow([
        "launchctl",
        "bootout",
        `gui/${uid}/${launchdLabel(unit)}`,
      ]);
    } catch (err) {
      console.warn(`[uninstall] bootout failed:`, (err as Error).message);
    }
    try {
      await rm(path);
      console.log(`[uninstall] removed ${path}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
    return;
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}

/** Only a supervisor turns an exit into a restart; unsupervised it is a stop. */
function isSupervised(): boolean {
  const flag = Bun.env[SUPERVISED_ENV];
  return flag !== undefined && flag !== "" && flag !== "0";
}

function restart(): never {
  process.exit(0);
}

/**
 * A global install replaces the tree every pim daemon runs from, so restarting
 * only the one that was asked leaves the rest on old code — one machine in two
 * versions. `self` is left out: it exits last, under its own supervisor.
 */
async function restartSiblings(self: Unit): Promise<void> {
  if (process.platform === "linux") {
    for (const name of await installedUnits(
      systemdDir(),
      "pim-*.service",
      ".service"
    )) {
      if (name !== unitName(self)) {
        await restartOrWarn(["systemctl", "--user", "restart", name], name);
      }
    }
    return;
  }
  if (process.platform === "darwin") {
    const uid = process.getuid?.() ?? 0;
    for (const label of await installedUnits(
      launchAgentsDir(),
      "com.aaroncql.pim-*.plist",
      ".plist"
    )) {
      if (label !== launchdLabel(self)) {
        await restartOrWarn(
          ["launchctl", "kickstart", "-k", `gui/${uid}/${label}`],
          label
        );
      }
    }
  }
}

/** Whatever pim units exist, rather than the modes this build happens to know. */
async function installedUnits(
  dir: string,
  pattern: string,
  suffix: string
): Promise<ReadonlyArray<string>> {
  try {
    const files = await Array.fromAsync(
      new Bun.Glob(pattern).scan({ cwd: dir })
    );
    return files.map((file) => basename(file, suffix)).sort();
  } catch {
    return [];
  }
}

async function restartOrWarn(
  cmd: ReadonlyArray<string>,
  name: string
): Promise<void> {
  try {
    await runOrThrow(cmd);
  } catch (err) {
    console.warn(`[update] restarting ${name} failed:`, (err as Error).message);
  }
}

async function detectInstall(): Promise<Install> {
  const here = await realpath(Bun.fileURLToPath(import.meta.url));
  // Start above the workspace packages so the walk lands on the published
  // root (the one holding `.git`, `bin/pim.ts`, and the shipped version).
  const packageRoot = await findPackageRoot(
    join(dirname(here), "..", "..", "..", "..")
  );
  const hasGit = await pathExists(join(packageRoot, ".git"));
  return {
    kind: hasGit ? "dev" : "prod",
    packageRoot,
    pimEntry: join(packageRoot, "bin", "pim.ts"),
    bunPath: process.execPath,
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function findPackageRoot(start: string): Promise<string> {
  let dir = start;
  for (let i = 0; i < 32; i++) {
    if (await pathExists(join(dir, "package.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error(`Could not locate package root from ${start}`);
}

function unitName(unit: Unit): string {
  return `pim-${unit.mode}`;
}

function launchdLabel(unit: Unit): string {
  return `com.aaroncql.${unitName(unit)}`;
}

function modeArgs(unit: Unit): ReadonlyArray<string> {
  return ["--mode", unit.mode, ...(unit.args ?? [])];
}

function systemdDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

function launchAgentsDir(): string {
  return join(homedir(), "Library", "LaunchAgents");
}

function systemdUnitPath(unit: Unit): string {
  return join(systemdDir(), `${unitName(unit)}.service`);
}

function launchdPlistPath(unit: Unit): string {
  return join(launchAgentsDir(), `${launchdLabel(unit)}.plist`);
}

function launchdLogPath(unit: Unit): string {
  return join(homedir(), "Library", "Logs", `${unitName(unit)}.log`);
}

function unitPath(at: Install): string {
  return `${dirname(at.bunPath)}:/usr/local/bin:/usr/bin:/bin`;
}

function systemdUnit(unit: Unit, at: Install): string {
  return [
    "[Unit]",
    `Description=${unit.description}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `Environment=PATH=${unitPath(at)}`,
    `Environment=${SUPERVISED_ENV}=1`,
    `ExecStart=${at.bunPath} ${at.pimEntry} ${modeArgs(unit).join(" ")}`,
    "Restart=always",
    "RestartSec=2",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function launchdPlist(unit: Unit, at: Install): string {
  const logPath = launchdLogPath(unit);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${launchdLabel(unit)}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    `    <string>${at.bunPath}</string>`,
    `    <string>${at.pimEntry}</string>`,
    ...modeArgs(unit).map((arg) => `    <string>${arg}</string>`),
    `  </array>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    `    <key>PATH</key>`,
    `    <string>${unitPath(at)}</string>`,
    `    <key>${SUPERVISED_ENV}</key>`,
    `    <string>1</string>`,
    `  </dict>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <true/>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${logPath}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${logPath}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

async function lingerEnabled(): Promise<boolean> {
  const { code, stdout } = await Proc.run([
    "loginctl",
    "show-user",
    "--property=Linger",
  ]);
  return code === 0 && stdout.includes("Linger=yes");
}

async function runOrThrow(
  cmd: ReadonlyArray<string>,
  cwd?: string
): Promise<void> {
  const { code, stderr } = await Proc.run(cmd, { cwd, stdout: "inherit" });
  if (code !== 0) {
    throw new Error(
      `${cmd.join(" ")} exit ${code}: ${stderr.trim() || "(no stderr)"}`
    );
  }
}

export const Supervisor = {
  install,
  uninstall,
  restart,
  restartSiblings,
  isSupervised,
  detectInstall,
  systemdUnit,
  launchdPlist,
};
