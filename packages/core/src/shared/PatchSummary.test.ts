import { describe, expect, test } from "bun:test";

import { PatchSummary } from "./PatchSummary";

describe("PatchSummary.fromText", () => {
  test("summarizes an update", () => {
    const ops = PatchSummary.fromText(
      "*** Begin Patch\n*** Update File: src/foo.ts\n@@\n-const a = 1\n+const a = 2\n*** End Patch"
    );
    expect(ops).toEqual([{ kind: "update", path: "src/foo.ts" }]);
  });

  test("summarizes a delete", () => {
    const ops = PatchSummary.fromText(
      "*** Begin Patch\n*** Delete File: src/old.ts\n*** End Patch"
    );
    expect(ops).toEqual([{ kind: "delete", path: "src/old.ts" }]);
  });

  test("captures a rename's move target", () => {
    const ops = PatchSummary.fromText(
      "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: src/b.ts\n*** End Patch"
    );
    expect(ops).toEqual([
      { kind: "update", path: "src/a.ts", movePath: "src/b.ts" },
    ]);
  });

  test("summarizes a mixed multi-file patch in order", () => {
    const ops = PatchSummary.fromText(
      [
        "*** Begin Patch",
        "*** Add File: src/new.ts",
        "+hello",
        "*** Delete File: src/legacy.ts",
        "*** Update File: src/a.ts",
        "*** Move to: src/b.ts",
        "*** End Patch",
      ].join("\n")
    );
    expect(ops.map((op) => [op.kind, op.path, op.movePath])).toEqual([
      ["add", "src/new.ts", undefined],
      ["delete", "src/legacy.ts", undefined],
      ["update", "src/a.ts", "src/b.ts"],
    ]);
  });

  test("strips a leading @ and surrounding quotes from paths", () => {
    const ops = PatchSummary.fromText(
      '*** Begin Patch\n*** Delete File: @"src/old file.ts"\n*** End Patch'
    );
    expect(ops[0]?.path).toBe("src/old file.ts");
  });

  test("returns what it can from otherwise-malformed text", () => {
    const ops = PatchSummary.fromText(
      "*** Begin Patch\n*** Update File: src/weird.ts\n(garbage)\n*** End Patch"
    );
    expect(ops).toEqual([{ kind: "update", path: "src/weird.ts" }]);
  });

  test("returns an empty list for text with no file markers", () => {
    expect(PatchSummary.fromText("not a patch at all")).toEqual([]);
  });
});

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
