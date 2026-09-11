import type { AutocompleteProvider } from "@earendil-works/pi-tui";

/** A provider deferring to `current` for everything `overrides` does not replace. */
export function wrapProvider(
  current: AutocompleteProvider,
  overrides: Partial<AutocompleteProvider>
): AutocompleteProvider {
  return {
    getSuggestions: (lines, cursorLine, cursorCol, options) =>
      current.getSuggestions(lines, cursorLine, cursorCol, options),
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
      current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
    shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) =>
      current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ??
      true,
    ...overrides,
  };
}
