import { describe, expect, test } from "bun:test";

import { PatchSummary } from "./PatchSummary";

describe("PatchSummary.firstPath", () => {
  test("returns the first affected path", () => {
    const path = PatchSummary.firstPath(
      [
        "*** Begin Patch",
        "*** Update File: src/a.ts",
        "@@",
        "-x",
        "+y",
        "*** Delete File: src/b.ts",
        "*** End Patch",
      ].join("\n")
    );
    expect(path).toBe("src/a.ts");
  });

  test("returns undefined when no file marker is present", () => {
    expect(PatchSummary.firstPath("not a patch at all")).toBeUndefined();
  });
});
