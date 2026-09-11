import type {
  AutocompleteProviderFactory,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { rankCommands } from "#core/picker/commandRanker";
import { SLASH_PREFIX } from "#core/picker/token";
import { wrapProvider } from "../wrapProvider";

const MAX_VISIBLE_ROWS = 10;
const SLASH_LINES = ["/"];

export function createCommandPickerProviderFactory(): AutocompleteProviderFactory {
  return (current: AutocompleteProvider): AutocompleteProvider => {
    let answered: string | undefined;

    return wrapProvider(current, {
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        answered = undefined;
        const line = lines[cursorLine] ?? "";
        const beforeCursor = line.slice(0, cursorCol);

        const slashMatch = beforeCursor.match(SLASH_PREFIX);
        if (!slashMatch) {
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        }

        const all = await current.getSuggestions(SLASH_LINES, 0, 1, options);
        if (all === null) {
          return null;
        }

        const query = slashMatch[1] ?? "";
        const items = rankCommands(query, all.items, {
          limit: MAX_VISIBLE_ROWS,
        });
        if (items.length === 0) {
          return null;
        }
        answered = `/${query}`;
        return { items, prefix: answered };
      },

      // Pi completes a slash command only where it opens the line; ours sits anywhere in it.
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        if (prefix !== answered) {
          return current.applyCompletion(
            lines,
            cursorLine,
            cursorCol,
            item,
            prefix
          );
        }
        const line = lines[cursorLine] ?? "";
        const head = line.slice(0, cursorCol - prefix.length);
        const tail = line.slice(cursorCol);
        const inserted = `/${item.value}${/^\s/.test(tail) ? "" : " "}`;
        const next = [...lines];
        next[cursorLine] = `${head}${inserted}${tail}`;
        return {
          lines: next,
          cursorLine,
          cursorCol: head.length + inserted.length,
        };
      },
    });
  };
}

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.addAutocompleteProvider(createCommandPickerProviderFactory());
  });
}
