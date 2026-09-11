import { defineConfig, presetIcons, presetWind4 } from "unocss";

export default defineConfig({
  // Scan `.ts` as well as `.tsx`: the default pipeline is JSX-only, so classes named in lookup tables get no rules.
  content: {
    pipeline: {
      include: [/\.[jt]sx?($|\?)/],
    },
  },
  presets: [
    presetWind4({
      preflights: {
        reset: true,
      },
    }),
    presetIcons(),
  ],
  theme: {
    text: {
      xs: { fontSize: "0.6875rem", lineHeight: "1rem" },
      sm: { fontSize: "0.75rem", lineHeight: "1.125rem" },
      base: { fontSize: "0.875rem", lineHeight: "1.25rem" },
      lg: { fontSize: "1rem", lineHeight: "1.5rem" },
      xl: { fontSize: "1.125rem", lineHeight: "1.75rem" },
      "2xl": { fontSize: "1.375rem", lineHeight: "1.875rem" },
      "3xl": { fontSize: "1.625rem", lineHeight: "2rem" },
      "4xl": { fontSize: "2rem", lineHeight: "2.25rem" },
    },
    colors: {
      neutral: {
        350: "oklch(78.9% 0 0)",
        750: "oklch(32% 0 0)",
        850: "oklch(23.7% 0 0)",
        925: "oklch(17.5% 0 0)",
      },
    },
    font: {
      mono: '"Commit Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      sans: '"Commit Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    },
  },
});
