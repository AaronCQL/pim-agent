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

const DEFAULT_DISABLED: readonly PimExtensionName[] = ["todo", "tps"];

let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * `_init` carries the Bun runtime guard and the splash.
 * `pim` is the only in-session way back from a disable.
 */
const REQUIRED: readonly PimExtensionName[] = ["_init", "pim"];

function isRequired(name: string): boolean {
  return (REQUIRED as readonly string[]).includes(name);
}

function isKnown(name: string): name is PimExtensionName {
  return name in EXTENSIONS;
}

function describe(name: PimExtensionName): string {
  return EXTENSIONS[name];
}

/**
 * Wraps a factory so a disabled extension registers nothing. Pi re-invokes
 * every factory on `ctx.reload()`, which is what makes a toggle land without
 * a restart — filtering the roster before `main` could not.
 */
function gate(
  name: PimExtensionName,
  factory: ExtensionFactory,
): ExtensionFactory {
  return async (pi) => {
    if (await isDisabled(name)) {
      return;
    }
    await factory(pi);
  };
}

async function disabled(): Promise<readonly PimExtensionName[]> {
  const { toggles } = await PimSettings.get("extensions");
  return NAMES.filter((name) => !enabled(name, toggles));
}

async function isDisabled(name: string): Promise<boolean> {
  if (!isKnown(name)) {
    return false;
  }
  const { toggles } = await PimSettings.get("extensions");
  return !enabled(name, toggles);
}

/** Serialized: the menu fires one of these per keypress, and each is a
 * read-modify-write of the same record. */
async function setDisabled(name: string, isOff: boolean): Promise<void> {
  if (!isKnown(name)) {
    throw new Error(`Unknown pim extension "${name}"`);
  }
  if (isOff && isRequired(name)) {
    throw new Error(`"${name}" is required by pim and cannot be disabled`);
  }
  const task = async (): Promise<void> => {
    const { toggles } = await PimSettings.get("extensions");
    const next = { ...toggles };
    if (!isOff === defaultEnabled(name)) {
      delete next[name];
    } else {
      next[name] = !isOff;
    }
    await PimSettings.set("extensions", { toggles: next });
  };
  writeQueue = writeQueue.then(task, task);
  await writeQueue;
}

async function toggle(
  name: string,
): Promise<{ readonly name: PimExtensionName; readonly disabled: boolean }> {
  if (!isKnown(name)) {
    throw new Error(`Unknown pim extension "${name}"`);
  }
  const isOff = !(await isDisabled(name));
  await setDisabled(name, isOff);
  return { name, disabled: isOff };
}

function defaultEnabled(name: PimExtensionName): boolean {
  return !DEFAULT_DISABLED.includes(name);
}

function enabled(
  name: PimExtensionName,
  toggles: Readonly<Record<string, boolean>>,
): boolean {
  if (isRequired(name)) {
    return true;
  }
  return toggles[name] ?? defaultEnabled(name);
}

export const ExtensionToggles = {
  REQUIRED,
  NAMES,
  isRequired,
  isKnown,
  describe,
  gate,
  disabled,
  isDisabled,
  setDisabled,
  toggle,
};
