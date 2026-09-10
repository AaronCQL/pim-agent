import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { Fs } from "./Fs";
import { Proc } from "./Proc";

// Set by the units this file writes and by nothing else: it tells a daemon an exit is a restart.
const SUPERVISED_ENV = "PIM_SUPERVISED";

/** One daemon the supervisor manages, named by the `--mode` it is started with. */
export type Unit = {
  readonly mode: string;
  readonly description: string;
  readonly args?: ReadonlyArray<string>;
};

/** One reversible act of an install: everything a unit's removal is made of. */
export type UnitStep =
  | { readonly kind: "run"; readonly cmd: ReadonlyArray<string> }
  | { readonly kind: "remove"; readonly path: string };

/** Which init system, and whose home — named so a test can ask about the other platform. */
export type UnitPlace = {
  readonly platform: NodeJS.Platform;
  readonly home: string;
};

export type InstallOptions = {
  /** Units this one replaces: stopped and removed before it is written. */
  readonly replaces?: ReadonlyArray<Unit>;
};

export type Install = {
  readonly kind: "dev" | "prod";
  readonly packageRoot: string;
  readonly pimEntry: string;
  readonly bunPath: string;
};

async function install(
  unit: Unit,
  options: InstallOptions = {}
): Promise<void> {
  const at = await detectInstall();
  console.log(`[install] ${at.kind} mode, root=${at.packageRoot}`);
  // Strictly before the new unit exists: two daemons must never share a token or a port.
  await supersede(options.replaces ?? []);
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
      // bootout fails when the service isn't loaded; ignore before bootstrap.
    }
    await runOrThrow(["launchctl", "bootstrap", `gui/${uid}`, path]);
    console.log(`[install] bootstrapped ${launchdLabel(unit)}`);
    return;
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}

async function uninstall(unit: Unit): Promise<void> {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error(`Unsupported platform: ${process.platform}`);
  }
  await runSteps(uninstallSteps(unit), "uninstall");
}

/**
 * Stop and remove every one of `units` that is installed, saying so. Idempotent:
 * a unit that was never installed, or is already stopped, costs a stat and a line.
 */
async function supersede(
  units: ReadonlyArray<Unit>,
  where: Partial<UnitPlace> = {}
): Promise<void> {
  for (const unit of await installedAmong(units, where)) {
    console.log(
      `[supersede] ${unitName(unit)} is no longer used; stopping and removing it`
    );
    await runSteps(uninstallSteps(unit, where), "supersede");
  }
}

/** Which of `units` this machine currently has a unit file for. */
async function installedAmong(
  units: ReadonlyArray<Unit>,
  where: Partial<UnitPlace> = {}
): Promise<ReadonlyArray<Unit>> {
  const present = await Promise.all(
    units.map((unit) => pathExists(unitFile(unit, where)))
  );
  return units.filter((_, index) => present[index]);
}

/**
 * The argv the installed unit starts the daemon with, empty when it is not
 * installed: what a re-install has to preserve rather than quietly drop.
 */
async function installedArgs(
  unit: Unit,
  where: Partial<UnitPlace> = {}
): Promise<ReadonlyArray<string>> {
  const at = place(where);
  const text = await Bun.file(unitFile(unit, at))
    .text()
    .catch(() => "");
  const words = unitWords(text, at.platform);
  // Everything before `--mode` is the interpreter and the entry point.
  const mode = words.indexOf("--mode");
  return mode < 0 ? [] : words.slice(mode);
}

function unitWords(
  text: string,
  platform: NodeJS.Platform
): ReadonlyArray<string> {
  if (platform === "darwin") {
    const argv = /<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? "";
    return [...argv.matchAll(/<string>([^<]*)<\/string>/g)].map(
      (match) => match[1]!
    );
  }
  return (/^ExecStart=(.*)$/m.exec(text)?.[1] ?? "")
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

/** Everything removing `unit` is made of, in the order it has to happen. */
function uninstallSteps(
  unit: Unit,
  where: Partial<UnitPlace> = {}
): ReadonlyArray<UnitStep> {
  const at = place(where);
  if (at.platform === "darwin") {
    const uid = process.getuid?.() ?? 0;
    return [
      {
        kind: "run",
        cmd: ["launchctl", "bootout", `gui/${uid}/${launchdLabel(unit)}`],
      },
      { kind: "remove", path: launchdPlistPath(unit, at) },
    ];
  }
  return [
    { kind: "run", cmd: ["systemctl", "--user", "stop", unitName(unit)] },
    { kind: "run", cmd: ["systemctl", "--user", "disable", unitName(unit)] },
    { kind: "remove", path: systemdUnitPath(unit, at) },
    { kind: "run", cmd: ["systemctl", "--user", "daemon-reload"] },
  ];
}

// A step that fails is reported, never fatal: an already-stopped unit still has
// to lose its file, and a file already gone still has to trigger a reload.
async function runSteps(
  steps: ReadonlyArray<UnitStep>,
  label: string
): Promise<void> {
  for (const step of steps) {
    if (step.kind === "run") {
      try {
        await runOrThrow(step.cmd);
      } catch (err) {
        console.warn(
          `[${label}] ${step.cmd.join(" ")} failed:`,
          (err as Error).message
        );
      }
      continue;
    }
    try {
      await rm(step.path);
      console.log(`[${label}] removed ${step.path}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
}

/** Only a supervisor turns an exit into a restart; unsupervised it is a stop. */
function isSupervised(): boolean {
  const flag = Bun.env[SUPERVISED_ENV];
  return flag !== undefined && flag !== "" && flag !== "0";
}

function restart(): never {
  process.exit(0);
}

// A global install replaces every daemon's tree: restart the siblings or they run old code.
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
  // Start above the workspace packages so the walk lands on the published root.
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

function place(where: Partial<UnitPlace> = {}): UnitPlace {
  return {
    platform: where.platform ?? process.platform,
    home: where.home ?? homedir(),
  };
}

function systemdDir(at: UnitPlace = place()): string {
  return join(at.home, ".config", "systemd", "user");
}

function launchAgentsDir(at: UnitPlace = place()): string {
  return join(at.home, "Library", "LaunchAgents");
}

function systemdUnitPath(unit: Unit, at: UnitPlace = place()): string {
  return join(systemdDir(at), `${unitName(unit)}.service`);
}

function launchdPlistPath(unit: Unit, at: UnitPlace = place()): string {
  return join(launchAgentsDir(at), `${launchdLabel(unit)}.plist`);
}

/** Where this platform keeps `unit`'s definition, installed or not. */
function unitFile(unit: Unit, where: Partial<UnitPlace> = {}): string {
  const at = place(where);
  return at.platform === "darwin"
    ? launchdPlistPath(unit, at)
    : systemdUnitPath(unit, at);
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
  supersede,
  installedAmong,
  installedArgs,
  uninstallSteps,
  unitFile,
  restart,
  restartSiblings,
  isSupervised,
  detectInstall,
  systemdUnit,
  launchdPlist,
};
