import { describe, expect, test } from "bun:test";
import { dirname, relative, resolve } from "node:path";

const packagesRoot = dirname(new URL(import.meta.url).pathname);

// Who may import whom. `protocol → core` is type-only (PickerItem, ViewBlock
// live in core); `web → server` is confined to test scaffolding and the
// fixture generator, but web ships built so nothing browser-bound leaks.
const allowed: Record<string, readonly string[]> = {
  core: [],
  protocol: ["core"],
  tui: ["core"],
  telegram: ["core"],
  server: ["core", "protocol"],
  web: ["core", "protocol", "server"],
};

const packageNames = Object.keys(allowed);

function targetPackage(file: string, specifier: string): string | undefined {
  const aliased = /^#([a-z]+)\//.exec(specifier);
  if (aliased) {
    return aliased[1];
  }
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const resolved = resolve(dirname(file), specifier);
  const inside = /^([a-z]+)\//.exec(relative(packagesRoot, resolved));
  return inside && packageNames.includes(inside[1]!) ? inside[1] : undefined;
}

async function importsOf(file: string): Promise<readonly string[]> {
  const source = await Bun.file(file).text();
  const specifiers: string[] = [];
  for (const match of source.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g
  )) {
    specifiers.push(match[1]!);
  }
  return specifiers;
}

const filesOf = (pkg: string) =>
  Array.from(
    new Bun.Glob(`${pkg}/src/**/*.{ts,tsx}`).scanSync({ cwd: packagesRoot })
  ).map((path) => resolve(packagesRoot, path));

describe("layer boundaries", () => {
  test.each(packageNames)("%s imports only its allowed layers", async (pkg) => {
    const violations: string[] = [];
    for (const file of filesOf(pkg)) {
      for (const specifier of await importsOf(file)) {
        const target = targetPackage(file, specifier);
        if (target && target !== pkg && !allowed[pkg]!.includes(target)) {
          violations.push(
            `${relative(packagesRoot, file)}: "${specifier}" reaches ${target}`
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
