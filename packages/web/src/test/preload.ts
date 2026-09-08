import { transform } from "@solidjs/compiler";
import { plugin } from "bun";
import { afterEach } from "bun:test";
import { dirname, join } from "node:path";

/**
 * What Vite does for `packages/web` in a build, done for `bun test`, which has
 * no Vite in front of it. Three halves, all keyed to specifiers only that
 * package uses, so the rest of the suite is untouched.
 *
 * JSX: without this, `.tsx` reaches Bun's generic transform, which knows
 * nothing about Solid's template compilation. This runs the same Oxc compiler
 * `@solidjs/vite-plugin` runs.
 *
 * Resolution: `solid-js` and `@solidjs/web` export a server build under the
 * `node` condition, and its `template` throws on sight — so every `.tsx` test
 * used to fail unless the run passed `--conditions=browser`, a flag nobody
 * types and no config file can set. These pin the same files that condition
 * picks, which makes a browser test a test you can just run.
 *
 * `build.module` rather than `onResolve` because Bun's runtime plugins ignore
 * `onResolve` — silently, so the flag was the only thing that ever worked.
 *
 * Diagnostics: the pinned builds are the *dev* ones, and everything they
 * report fails the test that provoked it. See below.
 */
const DOM_BUILDS = {
  "solid-js": "dist/dev.js",
  "@solidjs/web": "dist/dev.js",
  // Solid's reactive core, and where every diagnostic below is raised.
  // Pinned by name because `solid-js`'s own dev build imports it as a bare
  // specifier: left to the resolver it comes back as the production build,
  // which is the same graph with the checks compiled out — a suite that
  // renders every screen and can observe none of them.
  "@solidjs/signals": "dist/dev.js",
} as const;

plugin({
  name: "solid",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async (args) => ({
      // Oxc leaves the TypeScript annotations in place and only rewrites JSX,
      // so Bun still has to strip types afterwards: loader `ts`, not `js`.
      loader: "ts",
      contents: transform(await Bun.file(args.path).text(), {
        filename: args.path,
        generate: "dom",
        moduleName: "@solidjs/web",
      }).code,
    }));
    for (const [specifier, entry] of Object.entries(DOM_BUILDS)) {
      // Resolved off the package's own `package.json`, which every condition
      // agrees on; a rename of the entry beside it fails the import by name.
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

/**
 * A Solid diagnostic fails the test that provoked it.
 *
 * These are the dev runtime's own findings — a read that will never update, a
 * cleanup that will never run — and they are reported from the frame that did
 * it, which no static check can see: whether `observeHeight` leaks depends on
 * who called it, and both callers are the same line of source. The suite
 * already drives every screen, so it already provokes them; until now it just
 * had the production build loaded and could not hear.
 *
 * The runtime `console.warn`s each one as it happens, so this does not repeat
 * the message for its own sake — it fails, and it names the frame in
 * `packages/web` that the warning does not carry.
 */
const diagnostics: string[] = [];
const { DEV } = await import("solid-js");
if (DEV === undefined) {
  // Only the production build is missing it, and that build reports nothing:
  // the alternative to this line is a suite that passes because it went deaf.
  throw new Error("solid-js resolved to a build with no diagnostics");
}
DEV.diagnostics.subscribe((event) => {
  // Attribution codes are measurements of cost, not defects, and only fire
  // with attribution enabled; `info` is where their leads land.
  if (event.severity === "info") {
    return;
  }
  diagnostics.push(`${event.code} ${site()}`);
});

/**
 * The frame that provoked it: ours, and not the harness that got it there.
 * Within a line or two of the source in a `.tsx` — the stack names the
 * compiled template, and Bun does not chain the compiler's map through its
 * own TypeScript pass.
 */
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
