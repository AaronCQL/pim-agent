import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rankCommands } from "#core/picker/commandRanker";
import { SLASH_PREFIX } from "#core/picker/token";
import { wrapProvider } from "../wrapProvider";

const MAX_VISIBLE_ROWS = 10;
const SLASH_LINES = ["/"];

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.addAutocompleteProvider((current) =>
      wrapProvider(current, {
        async getSuggestions(lines, cursorLine, cursorCol, options) {
          const line = lines[cursorLine] ?? "";
          const beforeCursor = line.slice(0, cursorCol);

          const slashMatch = beforeCursor.match(SLASH_PREFIX);
          if (!slashMatch) {
            return current.getSuggestions(
              lines,
              cursorLine,
              cursorCol,
              options
            );
          }

          const all = await current.getSuggestions(SLASH_LINES, 0, 1, options);
          if (all === null) {
            return null;
          }

          const items = rankCommands(slashMatch[1] ?? "", all.items, {
            limit: MAX_VISIBLE_ROWS,
          });
          if (items.length === 0) {
            return null;
          }
          return { items, prefix: beforeCursor };
        },
      })
    );
  });
}
