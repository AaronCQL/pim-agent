import type {
  AutocompleteProviderFactory,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import type { FilePickerSuggestionEngine } from "./FilePickerSuggestionEngine";
import { WorkerFilePickerSuggestionEngine } from "./WorkerFilePickerSuggestionEngine";

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

function activeAtTokenFromMatch(
  match: RegExpMatchArray,
  cursorLine: number
): ActiveAtToken {
  const matchedText = match[0] ?? "";
  const matchCol = match.index ?? 0;
  const atCol = matchCol + (matchedText.startsWith("@") ? 0 : 1);
  return { cursorLine, atCol };
}

function sameActiveAtToken(
  a: ActiveAtToken | undefined,
  b: ActiveAtToken
): boolean {
  return a?.cursorLine === b.cursorLine && a.atCol === b.atCol;
}

export type FilePickerProviderFactoryOptions = {
  readonly engine: FilePickerSuggestionEngine;
};

type ActiveAtToken = {
  readonly cursorLine: number;
  readonly atCol: number;
};

export function createFilePickerProviderFactory(
  options: FilePickerProviderFactoryOptions
): AutocompleteProviderFactory {
  const refreshRelative = (): void => {
    void options.engine.refreshRelative();
  };

  return (current: AutocompleteProvider): AutocompleteProvider => {
    let activeAtToken: ActiveAtToken | undefined;

    return {
      async getSuggestions(lines, cursorLine, cursorCol, autocompleteOptions) {
        const line = lines[cursorLine] ?? "";
        const beforeCursor = line.slice(0, cursorCol);

        const atMatch = beforeCursor.match(AT_PREFIX);
        if (!atMatch) {
          activeAtToken = undefined;
          return current.getSuggestions(
            lines,
            cursorLine,
            cursorCol,
            autocompleteOptions
          );
        }

        const query = atMatch[1] ?? "";
        const atToken = activeAtTokenFromMatch(atMatch, cursorLine);
        if (!sameActiveAtToken(activeAtToken, atToken)) {
          activeAtToken = atToken;
          refreshRelative();
        }

        const items = await options.engine
          .rank(query, {
            limit: MAX_VISIBLE_ROWS,
            signal: autocompleteOptions.signal,
          })
          .catch(() => undefined);
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
    };
  };
}

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.addAutocompleteProvider(
      createFilePickerProviderFactory({
        engine: new WorkerFilePickerSuggestionEngine(ctx.cwd),
      })
    );
  });
}
