import { transform } from "@solidjs/compiler";
import { plugin } from "bun";
import { afterEach } from "bun:test";
import { dirname, join } from "node:path";

// Solid's JSX compile and browser dev builds for `bun test`: the `node` condition's
// `template` throws, and Bun's runtime plugins silently ignore `onResolve`.
const DOM_BUILDS = {
  "solid-js": "dist/solid.dev.js",
  "@solidjs/web": "dist/web.dev.js",
  // Pinned by name: solid-js's dev build imports it bare, and the resolver
  // would hand back the production build, with the diagnostics compiled out.
  "@solidjs/signals": "dist/dev.js",
} as const;

plugin({
  name: "solid",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async (args) => ({
      // Oxc only rewrites JSX, so Bun still strips types: loader `ts`, not `js`.
      loader: "ts",
      contents: transform(await Bun.file(args.path).text(), {
        filename: args.path,
        generate: "dom",
        moduleName: "@solidjs/web",
      }).code,
    }));
    for (const [specifier, entry] of Object.entries(DOM_BUILDS)) {
      // Resolved off the package's own `package.json`, which every condition agrees on.
      const path = join(
        dirname(Bun.resolveSync(`${specifier}/package.json`, import.meta.dir)),
        entry
      );
      build.module(specifier, async () => ({
        exports: await import(path),
        loader: "object",
      }));
    }
  },
});

// A Solid diagnostic fails the test that provoked it.
const diagnostics: string[] = [];
const { DEV } = await import("solid-js");
if (DEV === undefined) {
  // The production build reports nothing, so a suite loading it passes deaf.
  throw new Error("solid-js resolved to a build with no diagnostics");
}
DEV.diagnostics.subscribe((event) => {
  // Attribution codes measure cost rather than defects, and land on `info`.
  if (event.severity === "info") {
    return;
  }
  diagnostics.push(`${event.code} ${site()}`);
});

function site(): string {
  const frame = (new Error().stack ?? "")
    .split("\n")
    .find(
      (line) =>
        line.includes("/packages/web/src/") && !line.includes("/src/test/")
    );
  return (
    frame
      ?.trim()
      .replace(/^at\s+/, "")
      .replace(/\/.*\/packages\/web\/src\//, "") ?? "outside packages/web"
  );
}

afterEach(() => {
  const seen = [...new Set(diagnostics)];
  diagnostics.length = 0;
  if (seen.length > 0) {
    throw new Error(
      `Solid reported ${seen.length} diagnostic${seen.length === 1 ? "" : "s"}:\n  ${seen.join("\n  ")}`
    );
  }
});
