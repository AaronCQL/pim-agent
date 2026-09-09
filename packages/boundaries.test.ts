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

// Vite stubs Node built-ins for the browser, so a value import of one is not a
// build error — it is a blank page the first time the module body runs.
const aliases: Record<string, string> = {
  core: "core/src/",
  protocol: "protocol/src/",
  server: "server/src/",
  tui: "tui/src/",
  telegram: "telegram/src/",
  web: "web/src/",
};

const nodeOnly = (specifier: string) =>
  specifier.startsWith("node:") || specifier.startsWith("@earendil-works/");

function resolveModule(file: string, specifier: string): string | undefined {
  const aliased = /^#([a-z]+)\/(.+)$/.exec(specifier);
  const base = aliased
    ? resolve(packagesRoot, aliases[aliased[1]!] ?? "", aliased[2]!)
    : specifier.startsWith(".")
      ? resolve(dirname(file), specifier)
      : undefined;
  if (base === undefined) {
    return undefined;
  }
  const candidates = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base];
  return candidates.find(
    (path) => /\.tsx?$/.test(path) && Bun.file(path).size > 0
  );
}

/** Imports left after type erasure — the ones that actually reach the bundle. */
async function valueImportsOf(file: string): Promise<readonly string[]> {
  const loader = file.endsWith(".tsx") ? "tsx" : "ts";
  const source = await Bun.file(file).text();
  return new Bun.Transpiler({ loader })
    .scanImports(source)
    .map((record) => record.path);
}

describe("browser safety", () => {
  test("nothing the web entry loads reaches Node", async () => {
    const entry = resolve(packagesRoot, "web/src/main.tsx");
    const seen = new Set([entry]);
    const queue = [entry];
    const violations: string[] = [];
    while (queue.length > 0) {
      const file = queue.pop()!;
      for (const specifier of await valueImportsOf(file)) {
        if (nodeOnly(specifier)) {
          violations.push(`${relative(packagesRoot, file)}: "${specifier}"`);
          continue;
        }
        const next = resolveModule(file, specifier);
        if (next !== undefined && !seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
