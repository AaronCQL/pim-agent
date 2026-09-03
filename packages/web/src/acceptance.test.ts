import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * The architectural rules of the web client that are checkable without a
 * browser. They live as a test because each one is silently easy to break:
 * a `"use server"` would grow a second backend, and `@ark-ui/solid` declares
 * `solid-js: >=1.6.0`, so it installs against Solid 2 with no warning at all
 * and only fails at runtime.
 */

const ROOT = join(import.meta.dir, "..", "..", "..");
const WEB = join(import.meta.dir, "..");

/** Every web source but this file, whose own rules would match themselves. */
async function sources(): Promise<readonly string[]> {
  const paths: string[] = [];
  for await (const relative of new Bun.Glob("src/**/*.{ts,tsx}").scan({
    cwd: WEB,
  })) {
    if (!relative.endsWith("acceptance.test.ts")) {
      paths.push(join(WEB, relative));
    }
  }
  return paths;
}

describe("web client architecture rules", () => {
  test("zero server functions: the gateway is the only backend", async () => {
    for (const path of [...(await sources()), join(WEB, "vite.config.ts")]) {
      const text = await Bun.file(path).text();
      expect(`${path}: ${text.includes('"use server"')}`).toEndWith("false");
    }
  });

  test("the vite build is client-only", async () => {
    const config = await Bun.file(join(WEB, "vite.config.ts")).text();

    expect(config).not.toContain("start:");
    expect(config).not.toContain("ssr:");
    expect(config).toContain('outDir: "dist/client"');
  });

  test("no headless component library is installed", async () => {
    const lock = await Bun.file(join(ROOT, "bun.lock")).text();

    for (const banned of ["@ark-ui/", "@kobalte/", "corvu"]) {
      expect(`${banned} present: ${lock.includes(banned)}`).toEndWith("false");
    }
  });

  test("only ui/ touches a platform overlay primitive", async () => {
    // Authoring one, not naming one: a test may assert on the DOM a wrapper
    // produced, but nothing outside `ui/` may build or drive the primitive
    // itself.
    const authored =
      /<details|<dialog|popover=|showModal\(|showPopover\(|hidePopover\(/;
    for (const path of await sources()) {
      if (path.includes("/ui/")) {
        continue;
      }
      const text = await Bun.file(path).text();
      expect(`${path}: ${authored.test(text)}`).toEndWith("false");
    }
  });

  test("no v1 Solid primitive survived the migration notes", async () => {
    const removed = [
      "createResource",
      "startTransition",
      "useTransition",
      "createComputed",
      "createMutable",
      "classList=",
      "<Suspense",
      "<ErrorBoundary",
      "<Index",
    ];
    for (const path of await sources()) {
      const text = await Bun.file(path).text();
      const found = removed.filter((name) => text.includes(name));
      expect(`${path}: ${found.join(",")}`).toEndWith(": ");
    }
  });

  test("web is not in the published tarball", async () => {
    const manifest = await Bun.file(join(ROOT, "package.json")).json();

    expect(manifest.files).not.toContain("packages/web/src/");
    expect(JSON.stringify(manifest.dependencies)).not.toContain("solid");
  });
});
