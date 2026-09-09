import { basename, resolve, sep } from "node:path";

/** Reduces a client-supplied name to one harmless path segment. */
function safeName(name: string): string {
  return basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** Resolves `child` under `parent`, refusing anything that escapes it. */
function contain(parent: string, child: string): string {
  const path = resolve(parent, child);
  if (!path.startsWith(`${resolve(parent)}${sep}`)) {
    throw new Error(`refusing path outside ${parent}: ${child}`);
  }
  return path;
}

export const SafePath = { safeName, contain };
