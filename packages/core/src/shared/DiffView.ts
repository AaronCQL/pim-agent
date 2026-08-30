import type { ToolDiff } from "./DiffLines";

export type DiffStats = {
  readonly added: number;
  readonly removed: number;
};

export class DiffView {
  public static countStats(diff: ToolDiff | undefined): DiffStats {
    if (!diff) {
      return { added: 0, removed: 0 };
    }

    let added = 0;
    let removed = 0;

    for (const hunk of diff.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "added") {
          added += 1;
        } else if (line.kind === "removed") {
          removed += 1;
        }
      }
    }

    return { added, removed };
  }
}
