import solid from "@solidjs/vite-plugin";
import unocss from "unocss/vite";
import { defineConfig } from "vite";

/**
 * Client mode only. `start` is left off entirely, so there is no server
 * runtime for a server-function directive to attach to: `vite build` emits a
 * static bundle that `pim-server` serves, and `pim-server` stays the only
 * backend. `acceptance.test.ts` enforces it.
 *
 * The plugin defaults to Solid's Oxc compiler; adding a Babel pass here would
 * forfeit that, so don't.
 */
export default defineConfig({
  plugins: [unocss(), solid()],
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    target: "es2022",
  },
});
