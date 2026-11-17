import { dirname } from "node:path";

import type { HLJSApi } from "highlight.js";

import { Zig } from "./Zig";

// Pi highlights with its own private highlight.js; the only way in is the same module instance.
function register(): void {
  try {
    const pi = Bun.resolveSync(
      "@earendil-works/pi-coding-agent",
      import.meta.dir
    );
    const hljs = require(
      Bun.resolveSync("highlight.js/lib/core.js", dirname(pi))
    ) as HLJSApi;
    hljs.registerLanguage("zig", Zig.grammar);
  } catch {
    // Highlighting is cosmetic; a pi that moved its highlighter leaves zig plain.
  }
}

export const PiHighlight = { register };
