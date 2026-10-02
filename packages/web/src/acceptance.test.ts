import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const WEB = join(import.meta.dir, "..");

/** Every web source except this file, which would match its own rules. */
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

  // These declare `solid-js >=1.6`, so they install silently and fail at runtime.
  test("no headless component library is installed", async () => {
    const lock = await Bun.file(join(ROOT, "bun.lock")).text();

    for (const banned of ["@ark-ui/", "@kobalte/", "corvu"]) {
      expect(`${banned} present: ${lock.includes(banned)}`).toEndWith("false");
    }
  });

  test("only ui/ touches a platform overlay primitive", async () => {
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

  // Otherwise classes in `.ts` lookup tables silently get no CSS.
  test("the stylesheet is generated from .ts as well as .tsx", async () => {
    const config = await Bun.file(join(WEB, "uno.config.ts")).text();

    expect(config).toContain("pipeline");
    expect(config).toContain("/\\.[jt]sx?($|\\?)/");
  });

  // It is the largest dependency, so keep it out of the entry bundle.
  test("highlight.js is only ever reached through a dynamic import", async () => {
    for (const path of await sources()) {
      const text = await Bun.file(path).text();
      const statc = /(?:^|\n)\s*import\s+(?!type\b)[^\n]*"highlight\.js/;
      expect(`${path}: ${statc.test(text)}`).toEndWith("false");
    }
  });
});
