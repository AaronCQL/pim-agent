import solid from "@solidjs/vite-plugin";
import unocss from "unocss/vite";
import { defineConfig } from "vite";

// No Babel pass: it would replace Solid's Oxc compiler.
export default defineConfig({
  plugins: [unocss(), solid()],
  publicDir: "../../assets/brand",
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    target: "es2022",
  },
});
