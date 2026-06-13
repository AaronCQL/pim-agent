import type {
  AutocompleteProviderFactory,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { type FileCandidate, loadRelative } from "./catalog";
import { rank } from "./ranker";

const MAX_VISIBLE_ROWS = 50;
const AT_PREFIX = /(?:^|\s)@(\S*)$/;

// Pi cancels autocomplete after Tab; for directories we want to keep
// drilling, so re-enter Tab on the next tick.
function keepDrilling(): void {
  setTimeout(() => {
    try {
      process.stdin.emit("data", "\t");
    } catch {}
  }, 0);
}

export type FilePickerProviderFactoryOptions = {
  readonly loadRelativeCatalog: () => Promise<readonly FileCandidate[]>;
};

export function createFilePickerProviderFactory(
  options: FilePickerProviderFactoryOptions
): AutocompleteProviderFactory {
  let cachedRelative: readonly FileCandidate[] | undefined;
  let relativeRefresh: Promise<void> | undefined;

  const refreshRelative = (): void => {
    relativeRefresh ??= options
      .loadRelativeCatalog()
      .then((catalog) => {
        cachedRelative = catalog;
      })
      .catch(() => {
        if (cachedRelative === undefined) {
          cachedRelative = [];
        }
      })
      .finally(() => {
        relativeRefresh = undefined;
      });
  };

  refreshRelative();

  return (current: AutocompleteProvider): AutocompleteProvider => ({
    async getSuggestions(lines, cursorLine, cursorCol, autocompleteOptions) {
      const line = lines[cursorLine] ?? "";
      const beforeCursor = line.slice(0, cursorCol);

      const atMatch = beforeCursor.match(AT_PREFIX);
      if (!atMatch) {
        return current.getSuggestions(
          lines,
          cursorLine,
          cursorCol,
          autocompleteOptions
        );
      }

      const query = atMatch[1] ?? "";
      refreshRelative();

      const items = await rank(query, {
        cachedRelative,
        limit: MAX_VISIBLE_ROWS,
      });
      if (items === undefined) {
        return current.getSuggestions(
          lines,
          cursorLine,
          cursorCol,
          autocompleteOptions
        );
      }
      if (items.length === 0) {
        return null;
      }
      return {
        items: items.map((item) => ({
          ...item,
          value: `@${item.value}`,
        })),
        prefix: `@${query}`,
      };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      // Pi appends a trailing space after file completions; apply @ items
      // ourselves so Tab inserts the bare path.
      if (prefix.startsWith("@")) {
        const line = lines[cursorLine] ?? "";
        const beforePrefix = line.slice(0, cursorCol - prefix.length);
        const afterCursor = line.slice(cursorCol);
        const hasTrailingQuote = item.value.endsWith('"');
        const adjustedAfterCursor =
          prefix.startsWith('@"') &&
          hasTrailingQuote &&
          afterCursor.startsWith('"')
            ? afterCursor.slice(1)
            : afterCursor;

        const newLines = [...lines];
        newLines[cursorLine] =
          `${beforePrefix}${item.value}${adjustedAfterCursor}`;

        const isDirectory = item.label.endsWith("/");
        const cursorOffset =
          isDirectory && hasTrailingQuote
            ? item.value.length - 1
            : item.value.length;

        if (isDirectory) {
          keepDrilling();
        }

        return {
          lines: newLines,
          cursorLine,
          cursorCol: beforePrefix.length + cursorOffset,
        };
      }

      const result = current.applyCompletion(
        lines,
        cursorLine,
        cursorCol,
        item,
        prefix
      );
      if (item.value.endsWith("/")) {
        keepDrilling();
      }
      return result;
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return (
        current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ??
        true
      );
    },
  });
}

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.addAutocompleteProvider(
      createFilePickerProviderFactory({
        loadRelativeCatalog: () => loadRelative({ root: ctx.cwd }),
      })
    );
  });
}
