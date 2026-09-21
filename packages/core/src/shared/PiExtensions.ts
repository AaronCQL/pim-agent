import {
  DefaultPackageManager,
  type PackageSource,
  type ResolvedResource,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { basename, dirname, extname, relative } from "node:path";

import { ExtensionToggles } from "./ExtensionToggles";
import { Fs } from "./Fs";
import { Paths } from "./Paths";

/**
 * Every origin an entry comes from, in the order a reader meets them: the
 * roster is sorted by it, and a pane groups what it is handed without
 * restating it.
 */
const EXTENSION_GROUPS = ["pim", "package", "user", "project"] as const;

export type ExtensionGroup = (typeof EXTENSION_GROUPS)[number];

export type ExtensionEntry = {
  readonly id: string;
  readonly label: string;
  readonly group: ExtensionGroup;
  readonly enabled: boolean;
  /** Whether this process will write the toggle; a project-scoped entry is listed but not switched. */
  readonly writable: boolean;
};

export type ExtensionScope = {
  readonly cwd: string;
  readonly agentDir: string;
};

type Resolution = {
  readonly extensions: readonly ResolvedResource[];
  readonly settingsManager: SettingsManager;
};

type PackageFilter = Exclude<PackageSource, string>;

const FILTER_KEYS = ["extensions", "skills", "prompts", "themes"] as const;

const writes = Fs.serialised();

async function list(scope: ExtensionScope): Promise<readonly ExtensionEntry[]> {
  const [off, { extensions }] = await Promise.all([
    ExtensionToggles.disabled(),
    resolve(scope),
  ]);
  const disabled = new Set(off);
  const pim = ExtensionToggles.WEB.map((allowed) =>
    pimEntry(allowed, !disabled.has(allowed.name))
  );
  const pi = extensions
    .filter((resource) => resource.metadata.scope !== "temporary")
    .map(piEntry)
    .sort(byGroupThenLabel);
  return [...pim, ...pi];
}

async function setEnabled(
  id: string,
  enabled: boolean,
  scope: ExtensionScope
): Promise<void> {
  const pim = ExtensionToggles.WEB.find((entry) => `pim:${entry.name}` === id);
  if (pim) {
    await ExtensionToggles.setDisabled(pim.name, !enabled);
    return;
  }
  if (!id.startsWith("pi:")) {
    throw new Error(`Unknown extension "${id}"`);
  }
  await writes.run(() => writePiToggle(id.slice("pi:".length), enabled, scope));
}

// A fresh SettingsManager per write: `setExtensionPaths` persists its in-memory
// copy, which another process may have superseded since we last read it.
async function writePiToggle(
  path: string,
  enabled: boolean,
  scope: ExtensionScope
): Promise<void> {
  const { extensions, settingsManager } = await resolve(scope);
  const resource = extensions.find((candidate) => candidate.path === path);
  if (!resource) {
    throw new Error(`Unknown extension "pi:${path}"`);
  }
  const { metadata } = resource;
  if (metadata.scope !== "user") {
    throw new Error(
      `"${path}" is ${metadata.scope}-scoped and cannot be switched from here`
    );
  }
  if (metadata.origin === "package") {
    togglePackage(
      settingsManager,
      metadata.source,
      relative(metadata.baseDir ?? dirname(path), path),
      enabled
    );
  } else {
    toggleTopLevel(
      settingsManager,
      relative(metadata.baseDir ?? scope.agentDir, path),
      enabled
    );
  }
  await settingsManager.flush();
  const failure = settingsManager.drainErrors()[0];
  if (failure) {
    throw new Error(`Failed to write pi settings: ${failure.error.message}`);
  }
}

function toggleTopLevel(
  settingsManager: SettingsManager,
  pattern: string,
  enabled: boolean
): void {
  const current = settingsManager.getGlobalSettings().extensions ?? [];
  settingsManager.setExtensionPaths(withPattern(current, pattern, enabled));
}

function togglePackage(
  settingsManager: SettingsManager,
  source: string,
  pattern: string,
  enabled: boolean
): void {
  const packages = [...(settingsManager.getGlobalSettings().packages ?? [])];
  const index = packages.findIndex((entry) => sourceOf(entry) === source);
  const entry = packages[index];
  if (entry === undefined) {
    throw new Error(`No configured package provides "${source}"`);
  }
  const pkg: PackageFilter =
    typeof entry === "string" ? { source: entry } : { ...entry };
  const updated = withPattern(pkg.extensions ?? [], pattern, enabled);
  pkg.extensions = updated.length > 0 ? updated : undefined;
  packages[index] = FILTER_KEYS.some((key) => pkg[key] !== undefined)
    ? pkg
    : pkg.source;
  settingsManager.setPackages(packages);
}

function withPattern(
  current: readonly string[],
  pattern: string,
  enabled: boolean
): string[] {
  const kept = current.filter((entry) => stripMarker(entry) !== pattern);
  return [...kept, `${enabled ? "+" : "-"}${pattern}`];
}

function stripMarker(entry: string): string {
  return /^[!+-]/.test(entry) ? entry.slice(1) : entry;
}

function sourceOf(entry: PackageSource): string {
  return typeof entry === "string" ? entry : entry.source;
}

async function resolve(scope: ExtensionScope): Promise<Resolution> {
  const { cwd, agentDir } = scope;
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const manager = new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager,
  });
  // Without an answer, pi npm-installs every missing or drifted package, so a
  // bare listing request would fire off an install.
  const resolved = await manager.resolve(async () => "skip");
  return { extensions: resolved.extensions, settingsManager };
}

function pimEntry(
  allowed: (typeof ExtensionToggles.WEB)[number],
  enabled: boolean
): ExtensionEntry {
  return {
    id: `pim:${allowed.name}`,
    label: allowed.label,
    group: "pim",
    enabled,
    writable: true,
  };
}

function piEntry(resource: ResolvedResource): ExtensionEntry {
  const { path, metadata } = resource;
  const fromPackage = metadata.origin === "package";
  const group = fromPackage
    ? "package"
    : metadata.scope === "project"
      ? "project"
      : "user";
  return {
    id: `pi:${path}`,
    label: fromPackage
      ? metadata.source.replace(/^(?:npm|git):/, "")
      : fileLabel(path),
    group,
    enabled: resource.enabled,
    // Scope, not group: a package a project configures is written to the repo's
    // settings, which a browser toggle never touches.
    writable: metadata.scope === "user",
  };
}

function fileLabel(path: string): string {
  const base = basename(path, extname(path));
  return base === "index" ? basename(dirname(path)) : base;
}

function byGroupThenLabel(left: ExtensionEntry, right: ExtensionEntry): number {
  const byGroup =
    EXTENSION_GROUPS.indexOf(left.group) -
    EXTENSION_GROUPS.indexOf(right.group);
  return byGroup === 0
    ? Paths.compare(left.label.toLowerCase(), right.label.toLowerCase())
    : byGroup;
}

export const PiExtensions = { list, setEnabled };
