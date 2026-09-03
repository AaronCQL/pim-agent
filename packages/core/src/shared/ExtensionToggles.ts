import { PimSettings } from "./PimSettings";

// Pi filters `enabled` over disk paths only, and inline factories are appended
// after that filter (resource-loader.js:406/415), so `pim config` can never
// reach these. Pim owns the roster and the toggle instead.
const NAMES = [
  "_init",
  "apply-patch",
  "bash",
  "command-picker",
  "edit",
  "extension-toggle",
  "file-picker",
  "footer",
  "glob",
  "grep",
  "read",
  "subagent",
  "system-prompt",
  "todo",
  "tps",
  "web-fetch",
  "web-search",
  "working-indicator",
  "write",
] as const;

export type PimExtensionName = (typeof NAMES)[number];

type Named = {
  readonly name: string;
};

export class ExtensionToggles {
  /**
   * `_init` carries the Bun runtime guard and answers `resources_discover`
   * with pim's theme paths, so disabling it would silently drop pim's themes.
   * `extension-toggle` is the only in-session way back from a disable.
   */
  public static readonly REQUIRED: readonly PimExtensionName[] = [
    "_init",
    "extension-toggle",
  ];

  public static isRequired(name: string): boolean {
    return (ExtensionToggles.REQUIRED as readonly string[]).includes(name);
  }

  public static readonly NAMES: readonly PimExtensionName[] = NAMES;

  public static isKnown(name: string): name is PimExtensionName {
    return (NAMES as readonly string[]).includes(name);
  }

  public static filter<T extends Named>(
    extensions: readonly T[],
    disabled: Iterable<string>
  ): readonly T[] {
    const off = new Set(disabled);
    for (const required of ExtensionToggles.REQUIRED) {
      off.delete(required);
    }
    return extensions.filter((extension) => !off.has(extension.name));
  }

  public static async disabled(): Promise<readonly PimExtensionName[]> {
    const { disabled } = await PimSettings.get("extensions");
    return disabled.filter(
      (name): name is PimExtensionName =>
        ExtensionToggles.isKnown(name) && !ExtensionToggles.isRequired(name)
    );
  }

  public static async isDisabled(name: string): Promise<boolean> {
    return (await ExtensionToggles.disabled()).includes(
      name as PimExtensionName
    );
  }

  public static async setDisabled(
    name: string,
    disabled: boolean
  ): Promise<readonly PimExtensionName[]> {
    if (!ExtensionToggles.isKnown(name)) {
      throw new Error(`Unknown pim extension "${name}"`);
    }
    if (disabled && ExtensionToggles.isRequired(name)) {
      throw new Error(`"${name}" is required by pim and cannot be disabled`);
    }
    const current = await ExtensionToggles.disabled();
    const next = disabled
      ? [...new Set([...current, name])].sort()
      : current.filter((entry) => entry !== name);
    await PimSettings.set("extensions", { disabled: [...next] });
    return next;
  }

  public static async toggle(
    name: string
  ): Promise<{ readonly name: PimExtensionName; readonly disabled: boolean }> {
    if (!ExtensionToggles.isKnown(name)) {
      throw new Error(`Unknown pim extension "${name}"`);
    }
    const disabled = !(await ExtensionToggles.isDisabled(name));
    await ExtensionToggles.setDisabled(name, disabled);
    return { name, disabled };
  }
}
