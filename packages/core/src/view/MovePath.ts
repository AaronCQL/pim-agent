/**
 * A file that moved, read as one path rather than two. Everything the old and
 * new paths agree on is said once, and only the segments that actually changed
 * are named on both sides — `packages/{web ➝ tui}/src/App.tsx` rather than two
 * near-identical paths a reader has to diff by eye.
 */
export type MoveParts = {
  /** The leading directories both paths share, with its trailing `/`. */
  readonly prefix: string;
  /** What those segments used to be. */
  readonly from: string;
  /** What they are now. */
  readonly to: string;
  /** The trailing segments both paths share, with its leading `/`. */
  readonly suffix: string;
};

/** The arrow every surface draws a move with. */
const ARROW = "➝";

/**
 * The shared head and tail of a move, or `undefined` when there is nothing
 * worth folding: two paths that share no segment read better whole, since a
 * brace around the entire path only adds punctuation. Two bare filenames are
 * the exception — `{old.ts ➝ new.ts}` shares no segment but is still one name.
 */
function fold(oldPath: string, newPath: string): MoveParts | undefined {
  const oldParts = oldPath.split("/");
  const newParts = newPath.split("/");

  let head = 0;
  while (
    head < oldParts.length &&
    head < newParts.length &&
    oldParts[head] === newParts[head]
  ) {
    head += 1;
  }

  let tail = 0;
  while (
    tail < oldParts.length - head &&
    tail < newParts.length - head &&
    oldParts[oldParts.length - tail - 1] ===
      newParts[newParts.length - tail - 1]
  ) {
    tail += 1;
  }

  const from = oldParts.slice(head, oldParts.length - tail);
  const to = newParts.slice(head, newParts.length - tail);
  const bareNames = oldParts.length === 1 && newParts.length === 1;

  if (
    from.length === 0 ||
    to.length === 0 ||
    (head === 0 && tail === 0 && !bareNames)
  ) {
    return undefined;
  }

  return {
    prefix: head > 0 ? `${oldParts.slice(0, head).join("/")}/` : "",
    from: from.join("/"),
    to: to.join("/"),
    suffix: tail > 0 ? `/${oldParts.slice(-tail).join("/")}` : "",
  };
}

export const MovePath = { ARROW, fold };
