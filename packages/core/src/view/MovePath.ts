/** A move split for display as `packages/{web ➝ tui}/src/App.tsx`. */
export type MoveParts = {
  /** Shared leading segments, with a trailing `/`. */
  readonly prefix: string;
  readonly from: string;
  readonly to: string;
  /** Shared trailing segments, with a leading `/`. */
  readonly suffix: string;
};

const ARROW = "➝";

/** Undefined when the paths share no segment, unless both are bare filenames. */
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
