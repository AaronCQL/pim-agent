import { mkdir, realpath, rm, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { Fs } from "../../core/src/shared/Fs";

const UNIT_NAME = "pim-telegram";
const LAUNCHD_LABEL = "com.aaroncql.pim-telegram";
const NPM_PACKAGE = "@aaroncql/pim-agent";
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const CONFIRM_FILE = "update-confirm.json";

export type UpdateConfirmEntry = {
  readonly chatId: number;
  readonly threadId: number | undefined;
  readonly messageId: number;
};

export type Mode = {
  readonly kind: "dev" | "prod";
  readonly packageRoot: string;
  readonly pimEntry: string;
  readonly bunPath: string;
};

export type UpdateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export class Supervisor {
  public static async install(): Promise<void> {
    const mode = await Supervisor.detectMode();
    console.log(`[install] ${mode.kind} mode, root=${mode.packageRoot}`);
    if (process.platform === "linux") {
      const path = Supervisor.systemdUnitPath();
      await Fs.writeAtomic(path, Supervisor.systemdUnit(mode));
      console.log(`[install] wrote ${path}`);
      await Supervisor.runOrThrow(["systemctl", "--user", "daemon-reload"]);
      await Supervisor.runOrThrow([
        "systemctl",
        "--user",
        "enable",
        "--now",
        UNIT_NAME,
      ]);
      console.log(`[install] enabled and started ${UNIT_NAME}.service`);
      if (!(await Supervisor.lingerEnabled())) {
        console.log(
          `[install] hint: run 'loginctl enable-linger' so the service starts at boot without an active login`
        );
      }
      return;
    }
    if (process.platform === "darwin") {
      await mkdir(join(homedir(), "Library", "Logs"), { recursive: true });
      const path = Supervisor.launchdPlistPath();
      await Fs.writeAtomic(path, Supervisor.launchdPlist(mode));
      console.log(`[install] wrote ${path}`);
      const uid = process.getuid?.() ?? 0;
      try {
        await Supervisor.runOrThrow([
          "launchctl",
          "bootout",
          `gui/${uid}/${LAUNCHD_LABEL}`,
        ]);
      } catch {
        // bootout fails when the service isn't currently loaded; safe to ignore before bootstrap
      }
      await Supervisor.runOrThrow([
        "launchctl",
        "bootstrap",
        `gui/${uid}`,
        path,
      ]);
      console.log(`[install] bootstrapped ${LAUNCHD_LABEL}`);
      return;
    }
    throw new Error(`Unsupported platform: ${process.platform}`);
  }

  public static async uninstall(): Promise<void> {
    if (process.platform === "linux") {
      const path = Supervisor.systemdUnitPath();
      try {
        await Supervisor.runOrThrow([
          "systemctl",
          "--user",
          "disable",
          "--now",
          UNIT_NAME,
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
        await Supervisor.runOrThrow(["systemctl", "--user", "daemon-reload"]);
      } catch (err) {
        console.warn(
          `[uninstall] daemon-reload failed:`,
          (err as Error).message
        );
      }
      return;
    }
    if (process.platform === "darwin") {
      const path = Supervisor.launchdPlistPath();
      const uid = process.getuid?.() ?? 0;
      try {
        await Supervisor.runOrThrow([
          "launchctl",
          "bootout",
          `gui/${uid}/${LAUNCHD_LABEL}`,
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

  public static async update(): Promise<UpdateResult> {
    const mode = await Supervisor.detectMode();
    // Pi first: a newer pim may require a newer pi peer.
    const cmds =
      mode.kind === "dev"
        ? [["bun", "install"]]
        : [
            ["bun", "install", "-g", `${PI_PACKAGE}@latest`],
            ["bun", "install", "-g", `${NPM_PACKAGE}@latest`],
            // The bun-global copy is only the launcher; pi loads extensions
            // from its own package dir, whose semver range pins 0.x minors.
            ["pi", "install", `npm:${NPM_PACKAGE}@latest`],
          ];
    const cwd = mode.kind === "dev" ? mode.packageRoot : undefined;
    try {
      for (const cmd of cmds) {
        await Supervisor.runOrThrow(cmd, cwd);
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    return { ok: true };
  }

  public static restart(): never {
    process.exit(0);
  }

  public static async readVersion(): Promise<string> {
    const mode = await Supervisor.detectMode();
    const pkg = await Bun.file(join(mode.packageRoot, "package.json")).json();
    return Supervisor.versionOf(pkg);
  }

  public static async readPiVersion(): Promise<string> {
    try {
      const url = import.meta.resolve(`${PI_PACKAGE}/package.json`);
      const pkg = await Bun.file(Bun.fileURLToPath(url)).json();
      return Supervisor.versionOf(pkg);
    } catch {
      return "?";
    }
  }

  private static versionOf(pkg: { readonly version?: unknown }): string {
    return typeof pkg?.version === "string" ? pkg.version : "?";
  }

  public static async detectMode(): Promise<Mode> {
    if (Supervisor.cachedMode) {
      return Supervisor.cachedMode;
    }
    const here = await realpath(Bun.fileURLToPath(import.meta.url));
    // Start above the workspace package so the walk lands on the published
    // root (the one holding `.git`, `bin/pim.ts`, and the shipped version).
    const packageRoot = await Supervisor.findPackageRoot(
      join(dirname(here), "..", "..", "..")
    );
    const hasGit = await Supervisor.pathExists(join(packageRoot, ".git"));
    Supervisor.cachedMode = {
      kind: hasGit ? "dev" : "prod",
      packageRoot,
      pimEntry: join(packageRoot, "bin", "pim.ts"),
      bunPath: process.execPath,
    };
    return Supervisor.cachedMode;
  }

  public static async appendUpdateConfirm(
    configDir: string,
    entry: UpdateConfirmEntry
  ): Promise<void> {
    const merged = [...(await Supervisor.readUpdateConfirm(configDir)), entry];
    await Fs.writeAtomic(
      Supervisor.updateConfirmPath(configDir),
      JSON.stringify(merged, null, 2)
    );
  }

  public static async readUpdateConfirm(
    configDir: string
  ): Promise<ReadonlyArray<UpdateConfirmEntry>> {
    const data = await Fs.readJsonOrEmpty<unknown[]>(
      Supervisor.updateConfirmPath(configDir),
      []
    );
    if (!Array.isArray(data)) {
      return [];
    }
    return data.filter(
      (e): e is UpdateConfirmEntry =>
        !!e &&
        typeof e === "object" &&
        typeof (e as UpdateConfirmEntry).chatId === "number" &&
        ((e as UpdateConfirmEntry).threadId === undefined ||
          typeof (e as UpdateConfirmEntry).threadId === "number") &&
        typeof (e as UpdateConfirmEntry).messageId === "number"
    );
  }

  public static async clearUpdateConfirm(configDir: string): Promise<void> {
    try {
      await unlink(Supervisor.updateConfirmPath(configDir));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[update-confirm] unlink failed:`, err);
      }
    }
  }

  private static cachedMode: Mode | undefined;

  private static updateConfirmPath(configDir: string): string {
    return join(configDir, CONFIRM_FILE);
  }

  private static async pathExists(p: string): Promise<boolean> {
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  }

  private static async findPackageRoot(start: string): Promise<string> {
    let dir = start;
    for (let i = 0; i < 32; i++) {
      if (await Supervisor.pathExists(join(dir, "package.json"))) {
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

  private static systemdUnitPath(): string {
    return join(
      homedir(),
      ".config",
      "systemd",
      "user",
      `${UNIT_NAME}.service`
    );
  }

  private static launchdPlistPath(): string {
    return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  }

  private static launchdLogPath(): string {
    return join(homedir(), "Library", "Logs", `${UNIT_NAME}.log`);
  }

  private static unitPath(mode: Mode): string {
    return `${dirname(mode.bunPath)}:/usr/local/bin:/usr/bin:/bin`;
  }

  private static systemdUnit(mode: Mode): string {
    return [
      "[Unit]",
      "Description=Pim Telegram daemon",
      "After=network-online.target",
      "Wants=network-online.target",
      "",
      "[Service]",
      "Type=simple",
      `Environment=PATH=${Supervisor.unitPath(mode)}`,
      `ExecStart=${mode.bunPath} ${mode.pimEntry} --mode telegram`,
      "Restart=always",
      "RestartSec=2",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n");
  }

  private static launchdPlist(mode: Mode): string {
    const logPath = Supervisor.launchdLogPath();
    return [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
      `<plist version="1.0">`,
      `<dict>`,
      `  <key>Label</key>`,
      `  <string>${LAUNCHD_LABEL}</string>`,
      `  <key>ProgramArguments</key>`,
      `  <array>`,
      `    <string>${mode.bunPath}</string>`,
      `    <string>${mode.pimEntry}</string>`,
      `    <string>--mode</string>`,
      `    <string>telegram</string>`,
      `  </array>`,
      `  <key>EnvironmentVariables</key>`,
      `  <dict>`,
      `    <key>PATH</key>`,
      `    <string>${Supervisor.unitPath(mode)}</string>`,
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

  private static async lingerEnabled(): Promise<boolean> {
    const proc = Bun.spawn(["loginctl", "show-user", "--property=Linger"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      return false;
    }
    const out = await new Response(proc.stdout).text();
    return out.includes("Linger=yes");
  }

  private static async runOrThrow(
    cmd: ReadonlyArray<string>,
    cwd?: string
  ): Promise<void> {
    const proc = Bun.spawn([...cmd], {
      cwd,
      stdout: "inherit",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(
        `${cmd.join(" ")} exit ${code}: ${stderr.trim() || "(no stderr)"}`
      );
    }
  }
}
