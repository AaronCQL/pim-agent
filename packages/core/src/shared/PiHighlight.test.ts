import { describe, expect, test } from "bun:test";
import { highlightCode, initTheme } from "@earendil-works/pi-coding-agent";

import { PiHighlight } from "./PiHighlight";

describe("PiHighlight", () => {
  test("pi's own highlighter colours zig once it is registered", () => {
    initTheme("dark", false);
    PiHighlight.register();

    const source =
      'const std = @import("std");\npub fn main() u8 {\n    return 0x2A; // done\n}';
    const lines = highlightCode(source, "zig");
    const painted = lines.join("\n");

    expect(lines.map((line) => Bun.stripANSI(line))).toEqual(
      source.split("\n")
    );
    for (const word of [
      "const",
      "@import",
      '"std"',
      "pub",
      "fn",
      "main",
      "u8",
      "0x2A",
      "// done",
    ]) {
      expect(painted).toContain(`m${word}\x1b[`);
    }
  });
});
