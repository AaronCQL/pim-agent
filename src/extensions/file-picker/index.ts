import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type FileCandidate, loadRelative } from "./catalog";
import { rank } from "./ranker";

const MAX_VISIBLE_ROWS = 10;
const AT_PREFIX = /(?:^|\s)@(\S*)$/;

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    let cachedRelative: readonly FileCandidate[] | undefined;

    const refreshRelative = (): void => {
      void loadRelative({ root: ctx.cwd })
        .then((catalog) => {
          cachedRelative = catalog;
        })
        .catch(() => {
          cachedRelative = [];
        });
    };

    refreshRelative();

    ctx.ui.addAutocompleteProvider((current) => ({
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const line = lines[cursorLine] ?? "";
        const beforeCursor = line.slice(0, cursorCol);

        const atMatch = beforeCursor.match(AT_PREFIX);
        if (!atMatch) {
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        }

        const query = atMatch[1] ?? "";
        const items = await rank(query, {
          cachedRelative,
          limit: MAX_VISIBLE_ROWS,
        });
        if (items === undefined) {
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
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
        const result = current.applyCompletion(
          lines,
          cursorLine,
          cursorCol,
          item,
          prefix
        );
        // Pi cancels autocomplete after Tab; for directories we want to keep
        // drilling, so re-enter Tab on the next tick.
        if (typeof item.value === "string" && item.value.endsWith("/")) {
          setTimeout(() => {
            try {
              process.stdin.emit("data", "\t");
            } catch {}
          }, 0);
        }
        return result;
      },

      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return (
          current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ??
          true
        );
      },
    }));
  });
}
