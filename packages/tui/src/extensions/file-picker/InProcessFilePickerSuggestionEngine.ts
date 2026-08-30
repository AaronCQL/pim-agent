import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { FileCandidate } from "./catalog";
import type {
  FilePickerSuggestionEngine,
  RankFilePickerOptions,
} from "./FilePickerSuggestionEngine";
import { rank } from "./ranker";

export type InProcessFilePickerSuggestionEngineOptions = {
  readonly loadRelativeCatalog: () => Promise<readonly FileCandidate[]>;
};

export class InProcessFilePickerSuggestionEngine implements FilePickerSuggestionEngine {
  private cachedRelative: readonly FileCandidate[] | undefined;
  private refresh: Promise<void> | undefined;

  public constructor(
    private readonly options: InProcessFilePickerSuggestionEngineOptions
  ) {}

  public refreshRelative(): Promise<void> {
    this.refresh ??= this.options
      .loadRelativeCatalog()
      .then((catalog) => {
        this.cachedRelative = catalog;
      })
      .catch(() => {
        if (this.cachedRelative === undefined) {
          this.cachedRelative = [];
        }
      })
      .finally(() => {
        this.refresh = undefined;
      });

    return this.refresh;
  }

  public async rank(
    query: string,
    options: RankFilePickerOptions
  ): Promise<readonly AutocompleteItem[] | undefined> {
    if (options.signal?.aborted === true) {
      return [];
    }

    return rank(query, {
      cachedRelative: this.cachedRelative,
      limit: options.limit,
    });
  }
}
