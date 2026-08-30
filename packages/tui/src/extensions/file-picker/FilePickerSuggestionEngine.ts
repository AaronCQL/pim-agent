import type { AutocompleteItem } from "@earendil-works/pi-tui";

export type RankFilePickerOptions = {
  readonly limit?: number;
  readonly signal?: AbortSignal;
};

export type FilePickerSuggestionEngine = {
  readonly refreshRelative: () => Promise<void>;
  readonly rank: (
    query: string,
    options: RankFilePickerOptions
  ) => Promise<readonly AutocompleteItem[] | undefined>;
};
