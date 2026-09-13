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

/**
 * The file on disk is what a bare reference already names, so nothing is said
 * twice: no revision, no quote of lines the reader can go and read.
 */
test("a line comment on the working copy is the reference and what was written", () => {
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
    ["> src/a.ts:12", "", "Move this to the trailing edge."].join("\n")
  );
});

test("a range carries both ends and no count of what is between them", () => {
  const block = Review.compose(
    "worktree",
    [
      comment({
        path: "src/a.ts",
        side: "new",
        start: 141,
        end: 147,
        text: "Split this.",
      }),
    ],
    [file("src/a.ts")]
  );

  expect(block).toBe(["> src/a.ts:141-147", "", "Split this."].join("\n"));
});

/** The numbers belong to a revision, so the entry names the one git knows. */
test("an old-side comment names the revision its numbers belong to", () => {
  const worktree = Review.compose(
    "worktree",
    [comment({ path: "src/a.ts", side: "old", start: 141, end: 147 })],
    [file("src/a.ts")]
  );
  const unstaged = Review.compose(
    "unstaged",
    [comment({ path: "src/a.ts", side: "old", start: 141, end: 147 })],
    [file("src/a.ts")]
  );

  expect(worktree.split("\n")[0]).toBe("> src/a.ts:141-147 (HEAD)");
  expect(unstaged.split("\n")[0]).toBe("> src/a.ts:141-147 (index)");
});

/** `--cached` puts both sides in a revision: the new one is the index, not the disk. */
test("a staged diff names the index on the side that is not on disk", () => {
  const block = Review.compose(
    "staged",
    [
      comment({ path: "src/a.ts", side: "new", start: 4, end: 4 }),
      comment({ path: "src/a.ts", side: "old", start: 9, end: 9 }),
    ],
    [file("src/a.ts")]
  );

  expect(block.split("\n").filter((line) => line.startsWith("> "))).toEqual([
    "> src/a.ts:4 (index)",
    "> src/a.ts:9 (HEAD)",
  ]);
});

test("a comment on the file itself names no line and no revision", () => {
  const block = Review.compose(
    "staged",
    [comment({ path: "src/a.ts", text: "The whole thing is two things." })],
    [file("src/a.ts")]
  );

  expect(block).toBe(
    ["> src/a.ts", "", "The whole thing is two things."].join("\n")
  );
});

/**
 * No revision holds the working copy the reader read, so the quote is the only
 * anchor left — and the one place it is still worth its width.
 */
test("a new-side comment whose file has moved carries the line it was written against", () => {
  const block = Review.compose(
    "worktree",
    [
      comment({
        path: "src/a.ts",
        fingerprint: "before",
        side: "new",
        start: 1,
        end: 1,
        quote: "const pending = createMemo(() => ({",
        text: "still worth saying",
      }),
    ],
    [file("src/a.ts", "after")]
  );

  expect(block).toBe(
    [
      "> src/a.ts:1 (outdated, line read `const pending = createMemo(() => ({`)",
      "",
      "still worth saying",
    ].join("\n")
  );
});

/** HEAD and the index do not move when the working copy does. */
test("an old-side comment on a moved file keeps its plain reference", () => {
  const block = Review.compose(
    "worktree",
    [
      comment({
        path: "src/a.ts",
        fingerprint: "before",
        side: "old",
        start: 2,
        end: 2,
      }),
    ],
    [file("src/a.ts", "after")]
  );

  expect(block.split("\n")[0]).toBe("> src/a.ts:2 (HEAD)");
});

test("a long quote is elided and the comment still reads whole", () => {
  const long = `const x = "${"y".repeat(400)}";`;
  const block = Review.compose(
    "worktree",
    [
      comment({
        path: "src/a.ts",
        fingerprint: "before",
        side: "new",
        start: 3,
        end: 3,
        quote: long,
        text: "Shorter, please.",
      }),
    ],
    [file("src/a.ts", "after")]
  );

  const quoted = block.split("`")[1]!;
  expect(quoted).toHaveLength(120);
  expect(quoted.endsWith("…")).toBe(true);
  expect(long.startsWith(quoted.slice(0, -1))).toBe(true);
  expect(block).toContain("Shorter, please.");
});

test("a file the list does not carry is not claimed to have moved", () => {
  const block = Review.compose(
    "worktree",
    [comment({ path: "src/gone.ts", text: "sent from the conversation" })],
    []
  );

  expect(block).toBe(
    ["> src/gone.ts", "", "sent from the conversation"].join("\n")
  );
});

test("comments are grouped in the list's order, then by line, and parted by a rule", () => {
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

  expect(
    block.split(Review.DIVIDER).map((held) => held.split("\n")[0])
  ).toEqual([
    "> src/b.ts:4",
    "> src/b.ts:40-41",
    "> src/a.ts:9",
    "> src/a.ts",
    "> src/loose.ts",
  ]);
  expect(block).not.toContain("comments");
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
