import type { ToolDiffHunk } from "#core/shared/DiffLines";

export type ChangeMark = "added" | "modified" | "removedAbove" | "removedBelow";

/** Keyed by new-side line number. */
export type ChangeMarkMap = ReadonlyMap<number, ChangeMark>;

function of(hunks: readonly ToolDiffHunk[], total: number): ChangeMarkMap {
  const marks = new Map<number, ChangeMark>();
  for (const hunk of hunks) {
    let next = hunk.newStart;
    let removed = 0;
    let added: number[] = [];
    const close = (): void => {
      if (added.length > 0) {
        const mark = removed > 0 ? "modified" : "added";
        for (const line of added) {
          marks.set(line, mark);
        }
      } else if (removed > 0 && total > 0) {
        if (next > total) {
          marks.set(total, "removedBelow");
        } else {
          marks.set(Math.max(next, 1), "removedAbove");
        }
      }
      removed = 0;
      added = [];
    };
    for (const line of hunk.lines) {
      if (line.kind === "context") {
        next = line.newLine ?? next;
        close();
        next += 1;
      } else if (line.kind === "removed") {
        removed += 1;
      } else {
        const at = line.newLine ?? next;
        added.push(at);
        next = at + 1;
      }
    }
    close();
  }
  return marks;
}

function whole(total: number): ChangeMarkMap {
  return new Map(
    Array.from({ length: total }, (_, index) => [index + 1, "added"] as const)
  );
}

export const ChangeMarks = { of, whole };
