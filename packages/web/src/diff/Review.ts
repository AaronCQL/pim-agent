import type { ChangeSummary } from "#protocol/Diff";
import type { Comment, CommentSide } from "./Comments";
import type { BaseKind } from "./DiffStore";

/** Max characters of a quoted line. */
const QUOTE = 120;

/** Separates entries, and the review from the typed message. */
const DIVIDER = "\n\n---\n\n";

/** The revision each side is read from; absent means the working tree. */
const REVISIONS: Record<BaseKind, Partial<Record<CommentSide, string>>> = {
  worktree: { old: "HEAD" },
  unstaged: { old: "index" },
  staged: { old: "HEAD", new: "index" },
};

function elide(text: string): string {
  const line = text.trimEnd();
  return line.length > QUOTE ? `${line.slice(0, QUOTE - 1)}…` : line;
}

function span(comment: Comment): string {
  if (comment.start === undefined) {
    return "";
  }
  const end = comment.end ?? comment.start;
  return end === comment.start
    ? `:${comment.start}`
    : `:${comment.start}-${end}`;
}

function stale(comment: Comment): string {
  const quote = comment.quote?.trim();
  return quote === undefined || quote === ""
    ? "outdated"
    : `outdated, line read \`${elide(quote)}\``;
}

function notes(
  comment: Comment,
  base: BaseKind,
  outdated: boolean
): readonly string[] {
  const revision =
    comment.side === undefined ? undefined : REVISIONS[base][comment.side];
  return [
    ...(revision === undefined ? [] : [revision]),
    ...(outdated && comment.side === "new" ? [stale(comment)] : []),
  ];
}

function entry(comment: Comment, base: BaseKind, outdated: boolean): string {
  const said = notes(comment, base, outdated);
  const where = said.length === 0 ? "" : ` (${said.join(", ")})`;
  return `> ${comment.path}${span(comment)}${where}\n\n${comment.text.trim()}`;
}

function byLine(left: Comment, right: Comment): number {
  const ends = (comment: Comment): number =>
    comment.start ?? Number.MAX_SAFE_INTEGER;
  return ends(left) - ends(right) || left.createdAt - right.createdAt;
}

/** The review as one message block; blank comments are skipped. Empty if none. */
function compose(
  base: BaseKind,
  comments: readonly Comment[],
  files: readonly ChangeSummary[]
): string {
  const written = comments.filter((comment) => comment.text.trim() !== "");
  if (written.length === 0) {
    return "";
  }
  const order = new Map(files.map((file, at) => [file.path, at]));
  const fingerprints = new Map(
    files.map((file) => [file.path, file.fingerprint])
  );
  // File-list order, then paths the list doesn't have.
  const paths = [...new Set(written.map((comment) => comment.path))].sort(
    (left, right) =>
      (order.get(left) ?? files.length) - (order.get(right) ?? files.length)
  );
  return paths
    .flatMap((path) => {
      // Unlisted files are never outdated: the list may not have been read yet.
      const held = fingerprints.get(path);
      return written
        .filter((comment) => comment.path === path)
        .sort(byLine)
        .map((comment) =>
          entry(
            comment,
            base,
            held !== undefined && held !== comment.fingerprint
          )
        );
    })
    .join(DIVIDER);
}

export const Review = { compose, DIVIDER };
