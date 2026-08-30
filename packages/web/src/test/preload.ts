import { transform } from "@solidjs/compiler";
import { plugin } from "bun";

/**
 * `bun test` has no Vite in front of it, so JSX in `packages/web` would reach
 * Bun's generic transform, which knows nothing about Solid's template
 * compilation. This runs the same Oxc compiler `@solidjs/vite-plugin` runs.
 *
 * Registered from `bunfig.toml` so both test runs get it; only `packages/web`
 * ships `.tsx`, so nothing else is affected. Picking the browser builds of
 * `solid-js`/`@solidjs/web` is the other half and cannot be done here — Bun's
 * runtime plugins have no `onResolve` — so `test:web` passes
 * `--conditions=browser` instead. Under the default `node` condition both
 * resolve to the SSR build, whose `template` throws on sight.
 */
plugin({
  name: "solid-jsx",
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
  },
});
