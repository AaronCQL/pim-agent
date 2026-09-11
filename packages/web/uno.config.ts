import { defineConfig, presetIcons, presetWind4 } from "unocss";

/**
 * Icons come from `preset-icons`, one pack only: `griddy-icons`. Every icon
 * class is written literally in a template — the `ToolIcon` lookup table is
 * gone, because a tool row on the web leads with one mark that says whether
 * it opens, never with a glyph for what it is — so there is no `safelist` to
 * keep in sync.
 *
 * The type ramp and the font stack are the mockup's, verbatim. The root stays
 * at the browser default (16px) so rem spacing, radii and containers keep
 * their stock values; only type is retokenised here. `text-base` is applied to
 * `<body>` in `index.html`, since Wind4 only emits a theme token when a
 * matching utility is used.
 */
export default defineConfig({
  /**
   * Plain `.ts` as well as `.tsx`. UnoCSS scans what Vite transforms, and its
   * default pipeline is JSX-only — so a class named in a lookup table rather
   * than in a template (`tokens.ts`, which is *all* lookup tables) would have
   * no rule generated for it, and the palette would silently paint nothing.
   */
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
      xs: { fontSize: "0.6875rem", lineHeight: "1rem" }, // 11/16
      sm: { fontSize: "0.75rem", lineHeight: "1.125rem" }, // 12/18
      base: { fontSize: "0.875rem", lineHeight: "1.25rem" }, // 14/20
      lg: { fontSize: "1rem", lineHeight: "1.5rem" }, // 16/24
      xl: { fontSize: "1.125rem", lineHeight: "1.75rem" }, // 18/28
      "2xl": { fontSize: "1.375rem", lineHeight: "1.875rem" }, // 22/30
      "3xl": { fontSize: "1.625rem", lineHeight: "2rem" }, // 26/32
      "4xl": { fontSize: "2rem", lineHeight: "2.25rem" }, // 32/36
    },
    /**
     * The dark UI needs finer steps than the stock ramp: hairlines, card fills
     * and hover fills all live in gaps where the default jumps. Each value is
     * the midpoint of its neighbours, so the ramp stays even.
     */
    colors: {
      neutral: {
        350: "oklch(78.9% 0 0)", // between 300 (87%) and 400 (70.8%)
        750: "oklch(32% 0 0)", // between 700 (37.1%) and 800 (26.9%)
        850: "oklch(23.7% 0 0)", // between 800 (26.9%) and 900 (20.5%)
        925: "oklch(17.5% 0 0)", // between 900 (20.5%) and 950 (14.5%)
      },
    },
    font: {
      mono: '"Commit Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      sans: '"Commit Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    },
  },
});
