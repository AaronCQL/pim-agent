import { defineConfig, presetIcons, presetWind4 } from "unocss";

/**
 * Icons come from `preset-icons` because a tool row needs one glyph per
 * `ToolIcon` and the ANSI/Markdown painters already prove that set is small
 * and fixed. `safelist` covers the icon and tone classes, which are looked up
 * from a record at runtime and so never appear literally in a class string.
 */
export default defineConfig({
  presets: [presetWind4(), presetIcons({ scale: 1.1 })],
  safelist: [
    "file-text",
    "pencil",
    "trash-2",
    "terminal",
    "search",
    "list-checks",
    "globe",
    "upload",
    "clock",
    "bot",
    "wrench",
  ].map((name) => `i-lucide-${name}`),
});
