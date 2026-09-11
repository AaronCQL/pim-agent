import type {
  FilePickerSuggestionEngine,
  RankFilePickerOptions,
} from "./FilePickerSuggestionEngine";
import type { PickerItem } from "./PickerItem";

export type RemotePickerQuery = (
  query: string,
  limit: number | undefined
) => Promise<readonly PickerItem[]>;

const DEBOUNCE_MS = 30;

const CACHE_LIMIT = 100;

/** The client half of the `@` picker: the TUI's engine contract, answered by the server. Browser-safe APIs only. */
export class RemoteFilePickerSuggestionEngine implements FilePickerSuggestionEngine {
  private readonly cache = new Map<string, readonly PickerItem[]>();
  private generation = 0;

  public constructor(
    private readonly query: RemotePickerQuery,
    private readonly debounceMs: number = DEBOUNCE_MS
  ) {}

  /** The invalidation hook: `picker_invalidate` from the server lands here. */
  public refreshRelative(): Promise<void> {
    this.cache.clear();
    return Promise.resolve();
  }

  public async rank(
    query: string,
    options: RankFilePickerOptions
  ): Promise<readonly PickerItem[] | undefined> {
    const key = `${options.limit ?? ""}\u0000${query}`;
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }
    const mine = ++this.generation;
    await new Promise((resolve) => setTimeout(resolve, this.debounceMs));
    if (mine !== this.generation || options.signal?.aborted === true) {
      return [];
    }
    const items = await this.query(query, options.limit);
    this.cache.set(key, items);
    if (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
    return mine === this.generation ? items : [];
  }
}
