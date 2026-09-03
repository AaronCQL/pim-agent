import { isAbsolute, resolve, sep } from "node:path";

/** An entry of pi's `packages` setting: a bare source, or one with filters. */
export type PiPackageEntry =
  | string
  | {
      readonly source: string;
      readonly extensions?: readonly string[];
      readonly skills?: readonly string[];
      readonly prompts?: readonly string[];
      readonly themes?: readonly string[];
    };

export type SelfRegisterOptions = {
  /** Pi's user-scope settings file, `<agentDir>/settings.json`. */
  readonly settingsPath: string;
  /** Base dir that pi resolves relative local sources against. */
  readonly agentDir: string;
  readonly packageName: string;
  readonly packageRoot: string;
};

/**
 * Registers Pim with pi so a single `bun install -g` is the whole install.
 *
 * We register our own absolute path, not the `npm:` identity. Pi resolves a
 * local source by reading the directory in place, while an `npm:` source is
 * installed into `<agentDir>/npm` — it only reuses an existing global install
 * when pi's configured package manager is bun, and the default is npm, whose
 * `npm root -g` will not see a bun global install. An `npm:` entry therefore
 * downloads a second copy of Pim that then drifts from the launcher that
 * spawned it. A path entry keeps one copy, which `bun update -g` updates.
 */
export class PiPackageRegistry {
  /** @returns whether the settings file was written. */
  static async ensureSelfRegistered(o: SelfRegisterOptions): Promise<boolean> {
    // A checkout is registered by whoever checked it out; adding the `npm:`
    // identity here would make pi download an unrelated published copy.
    if (!PiPackageRegistry.isInstalledPackage(o.packageRoot)) {
      return false;
    }

    try {
      const settings = await PiPackageRegistry.readSettings(o.settingsPath);
      if (settings === undefined) {
        return false;
      }

      const entries = Array.isArray(settings["packages"])
        ? (settings["packages"] as readonly PiPackageEntry[])
        : [];
      if (await PiPackageRegistry.isRegistered(entries, o)) {
        return false;
      }

      const next = {
        ...settings,
        packages: [...entries, resolve(o.packageRoot)],
      };
      await Bun.write(o.settingsPath, `${JSON.stringify(next, null, 2)}\n`);
      return true;
    } catch {
      // Never let a read-only or malformed settings file block the launcher.
      return false;
    }
  }

  /** True once a `node_modules` segment sits above the package root. */
  static isInstalledPackage(packageRoot: string): boolean {
    return resolve(packageRoot).split(sep).includes("node_modules");
  }

  /** Pi's agent dir, honouring its `PI_CODING_AGENT_DIR` override. */
  static resolveAgentDir(env: Record<string, string | undefined>): string {
    const home = env["HOME"] ?? "";
    const override = env["PI_CODING_AGENT_DIR"]?.trim();
    if (!override) {
      return resolve(home, ".pi", "agent");
    }
    return override.startsWith("~")
      ? resolve(home, override.slice(override.startsWith("~/") ? 2 : 1))
      : resolve(override);
  }

  /** The package name of an `npm:` source, ignoring any pinned version. */
  static parseNpmName(source: string): string | undefined {
    if (!source.startsWith("npm:")) {
      return undefined;
    }
    const spec = source.slice("npm:".length).trim();
    const at = spec.lastIndexOf("@");
    return at > 0 ? spec.slice(0, at) : spec;
  }

  private static async isRegistered(
    entries: readonly PiPackageEntry[],
    o: SelfRegisterOptions
  ): Promise<boolean> {
    for (const entry of entries) {
      const source = typeof entry === "string" ? entry : entry.source;
      if (typeof source !== "string") {
        continue;
      }

      const npmName = PiPackageRegistry.parseNpmName(source);
      if (npmName !== undefined) {
        if (npmName === o.packageName) {
          return true;
        }
        continue;
      }

      // A local path may already point at this package — a checkout during
      // development, or a manual install. Identify it by name, not by path,
      // so a symlinked or relative entry still counts.
      const root = isAbsolute(source) ? source : resolve(o.agentDir, source);
      if ((await PiPackageRegistry.readPackageName(root)) === o.packageName) {
        return true;
      }
    }
    return false;
  }

  private static async readSettings(
    path: string
  ): Promise<Record<string, unknown> | undefined> {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return {};
    }
    const parsed: unknown = await file.json();
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  }

  private static async readPackageName(
    root: string
  ): Promise<string | undefined> {
    try {
      const pkg = (await Bun.file(`${root}/package.json`).json()) as {
        readonly name?: string;
      };
      return pkg.name;
    } catch {
      return undefined;
    }
  }
}
