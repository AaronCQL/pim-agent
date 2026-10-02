import { transform } from "@solidjs/compiler";
import { plugin } from "bun";
import { afterEach } from "bun:test";
import { dirname, join } from "node:path";

// Compiles Solid JSX and loads Solid's browser dev builds: the `node` build's
// `template` throws, and Bun's runtime plugins ignore `onResolve`.
const DOM_BUILDS = {
  "solid-js": "dist/solid.dev.js",
  "@solidjs/web": "dist/web.dev.js",
  // solid-js imports it bare, which would resolve to the production build.
  "@solidjs/signals": "dist/dev.js",
} as const;

plugin({
  name: "solid",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async (args) => ({
      // Oxc only rewrites JSX; Bun still strips the types.
      loader: "ts",
      contents: transform(await Bun.file(args.path).text(), {
        filename: args.path,
        generate: "dom",
        moduleName: "@solidjs/web",
      }).code,
    }));
    for (const [specifier, entry] of Object.entries(DOM_BUILDS)) {
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
  throw new Error("solid-js resolved to a build with no diagnostics");
}
DEV.diagnostics.subscribe((event) => {
  // `info` codes measure cost, not defects.
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
