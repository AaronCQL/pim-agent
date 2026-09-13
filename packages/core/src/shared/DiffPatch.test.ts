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

const DELETED = `diff --git a/del.txt b/del.txt
deleted file mode 100644
index 4208d7e..0000000
--- a/del.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-gone
-for good
`;

const RENAMED = `diff --git a/old-name.txt b/new-name.txt
similarity index 68%
rename from old-name.txt
rename to new-name.txt
index dc2b5bc..8ba42a9 100644
--- a/old-name.txt
+++ b/new-name.txt
@@ -1,3 +1,3 @@
 title
-body
+BODY
 tail
`;

const CRLF = [
  "diff --git a/crlf.txt b/crlf.txt",
  "index b5eff57..d5a6cc6 100644",
  "--- a/crlf.txt",
  "+++ b/crlf.txt",
  "@@ -1,3 +1,3 @@",
  " a\r",
  "-b\r",
  "+B\r",
  " c\r",
  "",
].join("\n");

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

const OMITTED_COUNTS = `diff --git a/one.txt b/one.txt
index 4994d72..161726a 100644
--- a/one.txt
+++ b/one.txt
@@ -1 +1 @@
-single
+SINGLE
`;

const MARKER_CONTENT = `diff --git a/trap.txt b/trap.txt
index 6b6368b..94ffbb6 100644
--- a/trap.txt
+++ b/trap.txt
@@ -1,4 +1,4 @@
 --- not a header
-+++ also not
++++ changed
 -- dash dash
 content
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

  test("reads a deleted file as removed lines only", () => {
    const diff = DiffPatch.fromUnified("del.txt", DELETED);
    expect(diff?.hunks[0]?.newLines).toBe(0);
    expect(diff?.hunks[0]?.lines).toEqual([
      { kind: "removed", oldLine: 1, text: "gone" },
      { kind: "removed", oldLine: 2, text: "for good" },
    ]);
  });

  test("reads a rename that also changed content", () => {
    const diff = DiffPatch.fromUnified("new-name.txt", RENAMED);
    expect(diff?.path).toBe("new-name.txt");
    expect(diff?.hunks[0]?.lines.map((line) => line.kind)).toEqual([
      "context",
      "removed",
      "added",
      "context",
    ]);
    expect(diff?.hunks[0]?.lines.map((line) => line.text)).toEqual([
      "title",
      "body",
      "BODY",
      "tail",
    ]);
  });

  test("preserves the carriage return of a CRLF file", () => {
    const diff = DiffPatch.fromUnified("crlf.txt", CRLF);
    expect(diff?.hunks[0]?.lines.map((line) => line.text)).toEqual([
      "a\r",
      "b\r",
      "B\r",
      "c\r",
    ]);
  });

  test("drops the no-newline marker when the old side lacked one", () => {
    const diff = DiffPatch.fromUnified("noeol.txt", NO_EOL_BEFORE);
    expect(diff?.hunks[0]?.lines).toEqual([
      { kind: "context", oldLine: 1, newLine: 1, text: "x" },
      { kind: "context", oldLine: 2, newLine: 2, text: "y" },
      { kind: "removed", oldLine: 3, text: "z" },
      { kind: "added", newLine: 3, text: "Z" },
    ]);
  });

  test("drops the no-newline marker when the new side lacks one", () => {
    const diff = DiffPatch.fromUnified("noeol.txt", NO_EOL_AFTER);
    expect(diff?.hunks[0]?.lines).toEqual([
      { kind: "context", oldLine: 1, newLine: 1, text: "p" },
      { kind: "context", oldLine: 2, newLine: 2, text: "q" },
      { kind: "removed", oldLine: 3, text: "r" },
      { kind: "added", newLine: 3, text: "R" },
    ]);
  });

  test("treats a hunk header with omitted counts as one line per side", () => {
    const diff = DiffPatch.fromUnified("one.txt", OMITTED_COUNTS);
    const hunk = diff?.hunks[0];
    expect([
      hunk?.oldStart,
      hunk?.oldLines,
      hunk?.newStart,
      hunk?.newLines,
    ]).toEqual([1, 1, 1, 1]);
    expect(hunk?.lines).toEqual([
      { kind: "removed", oldLine: 1, text: "single" },
      { kind: "added", newLine: 1, text: "SINGLE" },
    ]);
  });

  test("does not mistake content beginning with -- or +++ for headers", () => {
    const diff = DiffPatch.fromUnified("trap.txt", MARKER_CONTENT);
    expect(diff?.hunks).toHaveLength(1);
    expect(diff?.hunks[0]?.lines.map((line) => [line.kind, line.text])).toEqual(
      [
        ["context", "--- not a header"],
        ["removed", "+++ also not"],
        ["added", "+++ changed"],
        ["context", "-- dash dash"],
        ["context", "content"],
      ]
    );
  });

  test("returns undefined for a patch with no hunks", () => {
    expect(DiffPatch.fromUnified("plain.txt", MODE_ONLY)).toBeUndefined();
    expect(DiffPatch.fromUnified("blob.bin", BINARY)).toBeUndefined();
    expect(DiffPatch.fromUnified("empty.txt", "")).toBeUndefined();
  });
});
