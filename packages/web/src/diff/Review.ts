import type { ChangeSummary } from "#protocol/Diff";
import type { Comment } from "./Comments";
import type { BaseKind } from "./DiffStore";

/** How much of the quoted line is carried; the rest is behind the line number. */
const QUOTE = 120;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function elide(text: string): string {
  const line = text.trimEnd();
  return line.length > QUOTE ? `${line.slice(0, QUOTE - 1)}…` : line;
}

function where(comment: Comment): string {
  if (comment.start === undefined || comment.end === undefined) {
    return `${comment.path} (file)`;
  }
  const lines =
    comment.start === comment.end
      ? `${comment.start}`
      : `${comment.start}-${comment.end}`;
  return `${comment.path}:${lines} (${comment.side ?? "new"})`;
}

function entry(comment: Comment, outdated: boolean): string {
  const lines = [`${where(comment)}${outdated ? " (outdated)" : ""}`];
  if (comment.quote !== undefined && comment.quote.trim() !== "") {
    lines.push(`> ${elide(comment.quote)}`);
  }
  const rest = (comment.end ?? 0) - (comment.start ?? 0);
  if (rest > 0) {
    lines.push(`+${plural(rest, "more line")}`);
  }
  lines.push(comment.text.trim());
  return lines.join("\n");
}

function byLine(left: Comment, right: Comment): number {
  const ends = (comment: Comment): number =>
    comment.start ?? Number.MAX_SAFE_INTEGER;
  return ends(left) - ends(right) || left.createdAt - right.createdAt;
}

/**
 * What a reader has written, as the one block that rides the next message.
 * Empty when nothing has been written; a comment the reader has not typed
 * into yet says nothing and is left out.
 */
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
  // The list's order, then whatever a comment names that the list does not.
  const paths = [...new Set(written.map((comment) => comment.path))].sort(
    (left, right) =>
      (order.get(left) ?? files.length) - (order.get(right) ?? files.length)
  );
  const blocks = paths.flatMap((path) => {
    // A file the list does not carry cannot be said to have moved: the list
    // may never have been read at all, and every comment would wear it.
    const held = fingerprints.get(path);
    return written
      .filter((comment) => comment.path === path)
      .sort(byLine)
      .map((comment) =>
        entry(comment, held !== undefined && held !== comment.fingerprint)
      );
  });
  const header = `Review of the ${base} changes (${plural(
    written.length,
    "comment"
  )}, ${plural(paths.length, "file")}):`;
  return [header, ...blocks].join("\n\n");
}

export const Review = { compose };
