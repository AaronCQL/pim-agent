import { describe, expect, test } from "bun:test";
import { DiffPatch } from "./DiffPatch";

const MODIFY = `diff --git a/mod.ts b/mod.ts
index b64b2ac..e9bd193 100644
--- a/mod.ts
+++ b/mod.ts
@@ -1,2 +1,2 @@
-const value = 1;
+const value = 42;
 export { value };
`;

const MULTI_HUNK = `diff --git a/multi.txt b/multi.txt
index e031777..73b32b4 100644
--- a/multi.txt
+++ b/multi.txt
@@ -1,5 +1,5 @@
 one
-two
+TWO
 three
 four
 five
@@ -8,5 +8,5 @@ seven
 eight
 nine
 ten
-eleven
+ELEVEN
 twelve
`;

const ADDED = `diff --git a/added.txt b/added.txt
new file mode 100644
index 0000000..5786b13
--- /dev/null
+++ b/added.txt
@@ -0,0 +1,2 @@
+brand
+new
`;

const NO_EOL_BEFORE = `diff --git a/noeol.txt b/noeol.txt
index 66455a1..661264d 100644
--- a/noeol.txt
+++ b/noeol.txt
@@ -1,3 +1,3 @@
 x
 y
-z
\\ No newline at end of file
+Z
`;

const NO_EOL_AFTER = `diff --git a/noeol.txt b/noeol.txt
index 4c6f843..6d334bc 100644
--- a/noeol.txt
+++ b/noeol.txt
@@ -1,3 +1,3 @@
 p
 q
-r
+R
\\ No newline at end of file
`;

const MODE_ONLY = `diff --git a/plain.txt b/plain.txt
old mode 100644
new mode 100755
`;

const BINARY = `diff --git a/blob.bin b/blob.bin
new file mode 100644
index 0000000..b1feab4
Binary files /dev/null and b/blob.bin differ
`;

describe("DiffPatch.fromUnified", () => {
  test("maps a plain modification to kinds, line numbers and emphasis", () => {
    const diff = DiffPatch.fromUnified("mod.ts", MODIFY);
    expect(diff?.path).toBe("mod.ts");
    expect(diff?.hunks).toHaveLength(1);

    const hunk = diff?.hunks[0];
    expect(hunk?.oldStart).toBe(1);
    expect(hunk?.oldLines).toBe(2);
    expect(hunk?.newStart).toBe(1);
    expect(hunk?.newLines).toBe(2);
    expect(hunk?.lines).toEqual([
      {
        kind: "removed",
        oldLine: 1,
        text: "const value = 1;",
        emphasis: [{ start: 14, end: 15 }],
      },
      {
        kind: "added",
        newLine: 1,
        text: "const value = 42;",
        emphasis: [{ start: 14, end: 16 }],
      },
      { kind: "context", oldLine: 2, newLine: 2, text: "export { value };" },
    ]);
  });

  test("keeps each hunk's own line counters", () => {
    const diff = DiffPatch.fromUnified("multi.txt", MULTI_HUNK);
    expect(diff?.hunks).toHaveLength(2);

    const [first, second] = diff?.hunks ?? [];
    expect(first?.lines.map((line) => line.text)).toEqual([
      "one",
      "two",
      "TWO",
      "three",
      "four",
      "five",
    ]);
    expect(second?.oldStart).toBe(8);
    expect(second?.newStart).toBe(8);
    expect(
      second?.lines.map((line) => [line.kind, line.oldLine, line.newLine])
    ).toEqual([
      ["context", 8, 8],
      ["context", 9, 9],
      ["context", 10, 10],
      ["removed", 11, undefined],
      ["added", undefined, 11],
      ["context", 12, 12],
    ]);
  });

  test("reads an added file as added lines only", () => {
    const diff = DiffPatch.fromUnified("added.txt", ADDED);
    expect(diff?.hunks[0]?.oldLines).toBe(0);
    expect(diff?.hunks[0]?.lines).toEqual([
      { kind: "added", newLine: 1, text: "brand" },
      { kind: "added", newLine: 2, text: "new" },
    ]);
  });

  test.each([
    ["old", NO_EOL_BEFORE],
    ["new", NO_EOL_AFTER],
  ])("drops the no-newline marker on the %s side", (_, patch) => {
    expect(
      DiffPatch.fromUnified("noeol.txt", patch)?.hunks[0]?.lines.map(
        (line) => line.kind
      )
    ).toEqual(["context", "context", "removed", "added"]);
  });

  test("returns undefined for a patch with no hunks", () => {
    expect(DiffPatch.fromUnified("plain.txt", MODE_ONLY)).toBeUndefined();
    expect(DiffPatch.fromUnified("blob.bin", BINARY)).toBeUndefined();
    expect(DiffPatch.fromUnified("empty.txt", "")).toBeUndefined();
  });
});
