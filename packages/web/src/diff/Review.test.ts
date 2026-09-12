import { expect, test } from "bun:test";

import type { ChangeSummary } from "#protocol/Diff";
import type { Comment } from "./Comments";
import { Review } from "./Review";

let written = 0;

function comment(over: Partial<Comment> & { readonly path: string }): Comment {
  written += 1;
  return {
    id: `c${written}`,
    fingerprint: "f1",
    text: "say something",
    createdAt: written,
    ...over,
  };
}

function file(path: string, fingerprint = "f1"): ChangeSummary {
  return { path, status: "modified", added: 1, removed: 0, fingerprint };
}

test("a line comment carries its side, its quote and what was written", () => {
  const block = Review.compose(
    "worktree",
    [
      comment({
        path: "src/a.ts",
        side: "new",
        start: 12,
        end: 12,
        quote: "const w = memo(…)",
        text: "  Move this to the trailing edge.\n",
      }),
    ],
    [file("src/a.ts")]
  );

  expect(block).toBe(
    [
      "Review of the worktree changes (1 comment, 1 file):",
      "",
      "src/a.ts:12 (new)",
      "> const w = memo(…)",
      "Move this to the trailing edge.",
    ].join("\n")
  );
});

test("a range says how much of it the quote leaves out", () => {
  const block = Review.compose(
    "unstaged",
    [
      comment({
        path: "src/a.ts",
        side: "old",
        start: 141,
        end: 147,
        quote: "class RowBar {",
        text: "Split this.",
      }),
    ],
    [file("src/a.ts")]
  );

  expect(block).toContain(
    "Review of the unstaged changes (1 comment, 1 file):"
  );
  expect(block).toContain("src/a.ts:141-147 (old)");
  expect(block).toContain("> class RowBar {");
  expect(block).toContain("+6 more lines");
});

test("a comment on the file itself names no line and no side", () => {
  const block = Review.compose(
    "staged",
    [comment({ path: "src/a.ts", text: "The whole thing is two things." })],
    [file("src/a.ts")]
  );

  expect(block).toContain("src/a.ts (file)");
  expect(block).not.toContain(":undefined");
  expect(block).not.toContain(">");
});

test("a long quote is elided and the comment still reads whole", () => {
  const long = `const x = "${"y".repeat(400)}";`;
  const block = Review.compose(
    "worktree",
    [
      comment({
        path: "src/a.ts",
        side: "new",
        start: 3,
        end: 3,
        quote: long,
        text: "Shorter, please.",
      }),
    ],
    [file("src/a.ts")]
  );

  const quoted = block
    .split("\n")
    .find((line) => line.startsWith("> "))!
    .slice(2);
  expect(quoted).toHaveLength(120);
  expect(quoted.endsWith("…")).toBe(true);
  expect(long.startsWith(quoted.slice(0, -1))).toBe(true);
  expect(block).toContain("Shorter, please.");
});

test("a file whose fingerprint has moved is marked outdated, never dropped", () => {
  const block = Review.compose(
    "worktree",
    [
      comment({
        path: "src/a.ts",
        fingerprint: "old",
        side: "new",
        start: 1,
        end: 1,
        text: "still worth saying",
      }),
      comment({
        path: "src/b.ts",
        side: "old",
        start: 2,
        end: 2,
        text: "and this one has not moved",
      }),
    ],
    [file("src/a.ts", "new"), file("src/b.ts")]
  );

  expect(block).toContain("src/a.ts:1 (new) (outdated)");
  expect(block).toContain("still worth saying");
  expect(block).toContain("src/b.ts:2 (old)");
  expect(block).not.toContain("src/b.ts:2 (old) (outdated)");
});

test("a file the list does not carry is not claimed to have moved", () => {
  const block = Review.compose(
    "worktree",
    [comment({ path: "src/gone.ts", text: "sent from the conversation" })],
    []
  );

  expect(block).toContain("src/gone.ts (file)");
  expect(block).not.toContain("outdated");
});

test("comments are grouped in the list's order, then by line", () => {
  const block = Review.compose(
    "worktree",
    [
      comment({ path: "src/a.ts", text: "on the file" }),
      comment({
        path: "src/b.ts",
        side: "new",
        start: 40,
        end: 41,
        text: "second of b",
      }),
      comment({
        path: "src/a.ts",
        side: "new",
        start: 9,
        end: 9,
        text: "first of a",
      }),
      comment({
        path: "src/b.ts",
        side: "new",
        start: 4,
        end: 4,
        text: "first of b",
      }),
      comment({ path: "src/loose.ts", text: "no row of its own" }),
    ],
    [file("src/b.ts"), file("src/a.ts")]
  );

  expect(block.split("\n")[0]).toBe(
    "Review of the worktree changes (5 comments, 3 files):"
  );
  expect(
    block
      .split("\n")
      .filter((line) => line.startsWith("src/"))
      .map((line) => line)
  ).toEqual([
    "src/b.ts:4 (new)",
    "src/b.ts:40-41 (new)",
    "src/a.ts:9 (new)",
    "src/a.ts (file)",
    "src/loose.ts (file)",
  ]);
});

test("nothing written is no block at all", () => {
  expect(Review.compose("worktree", [], [file("src/a.ts")])).toBe("");
  expect(
    Review.compose(
      "worktree",
      [comment({ path: "src/a.ts", text: "   " })],
      [file("src/a.ts")]
    )
  ).toBe("");
});
