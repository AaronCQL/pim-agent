import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { PimSettings } from "./PimSettings";

// Pi filters `enabled` over disk paths only, and inline factories are appended
// after that filter (resource-loader.js:406/415), so `pim config` can never
// reach these. Pim owns the roster and the toggle instead.
const EXTENSIONS = {
  _init: "Splash screen, runtime guard, /clear",
  "apply-patch": "apply_patch tool",
  bash: "bash tool",
  "command-picker": "Slash command and skill autocomplete",
  edit: "edit tool",
  "file-picker": "@-path autocomplete",
  footer: "Powerline footer",
  glob: "glob tool",
  grep: "grep tool",
  pim: "This menu",
  read: "read tool",
  subagent: "subagent tool",
  "system-prompt": "Pim system prompt",
  todo: "todo tool",
  tps: "Per-turn decode/prefill tps report",
  "web-fetch": "web_fetch tool",
  "web-search": "web_search tool",
  "working-indicator": "Animated working indicator",
  write: "write tool",
} as const;

export type PimExtensionName = keyof typeof EXTENSIONS;

const NAMES = Object.keys(EXTENSIONS) as readonly PimExtensionName[];

/** Ships off: opt-in reporting rather than a capability. */
const DEFAULT_DISABLED: readonly PimExtensionName[] = ["tps"];

export class ExtensionToggles {
  private static writeQueue: Promise<unknown> = Promise.resolve();

  /**
   * `_init` carries the Bun runtime guard and the splash.
   * `pim` is the only in-session way back from a disable.
   */
  public static readonly REQUIRED: readonly PimExtensionName[] = [
    "_init",
    "pim",
  ];

  public static readonly NAMES: readonly PimExtensionName[] = NAMES;

  public static isRequired(name: string): boolean {
    return (ExtensionToggles.REQUIRED as readonly string[]).includes(name);
  }

  public static isKnown(name: string): name is PimExtensionName {
    return name in EXTENSIONS;
  }

  public static describe(name: PimExtensionName): string {
    return EXTENSIONS[name];
  }

  /**
   * Wraps a factory so a disabled extension registers nothing. Pi re-invokes
   * every factory on `ctx.reload()`, which is what makes a toggle land without
   * a restart — filtering the roster before `main` could not.
   */
  public static gate(
    name: PimExtensionName,
    factory: ExtensionFactory
  ): ExtensionFactory {
    return async (pi) => {
      if (await ExtensionToggles.isDisabled(name)) {
        return;
      }
      await factory(pi);
    };
  }

  public static async disabled(): Promise<readonly PimExtensionName[]> {
    const { toggles } = await PimSettings.get("extensions");
    return NAMES.filter((name) => !enabled(name, toggles));
  }

  public static async isDisabled(name: string): Promise<boolean> {
    if (!ExtensionToggles.isKnown(name)) {
      return false;
    }
    const { toggles } = await PimSettings.get("extensions");
    return !enabled(name, toggles);
  }

  /** Serialized: the menu fires one of these per keypress, and each is a
   * read-modify-write of the same record. */
  public static async setDisabled(
    name: string,
    disabled: boolean
  ): Promise<void> {
    if (!ExtensionToggles.isKnown(name)) {
      throw new Error(`Unknown pim extension "${name}"`);
    }
    if (disabled && ExtensionToggles.isRequired(name)) {
      throw new Error(`"${name}" is required by pim and cannot be disabled`);
    }
    const task = async (): Promise<void> => {
      const { toggles } = await PimSettings.get("extensions");
      const next = { ...toggles };
      if (!disabled === defaultEnabled(name)) {
        delete next[name];
      } else {
        next[name] = !disabled;
      }
      await PimSettings.set("extensions", { toggles: next });
    };
    ExtensionToggles.writeQueue = ExtensionToggles.writeQueue.then(task, task);
    await ExtensionToggles.writeQueue;
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

function defaultEnabled(name: PimExtensionName): boolean {
  return !DEFAULT_DISABLED.includes(name);
}

function enabled(
  name: PimExtensionName,
  toggles: Readonly<Record<string, boolean>>
): boolean {
  if (ExtensionToggles.isRequired(name)) {
    return true;
  }
  return toggles[name] ?? defaultEnabled(name);
}
